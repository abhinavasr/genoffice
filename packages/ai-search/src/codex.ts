/**
 * Wrapper around the OpenAI Codex CLI (`codex`) — the local AI orchestrator for
 * everything the Genspark `gsk` CLI used to do beyond chat: web/image search,
 * image generation, media analysis, transcription, and PDF -> DOCX conversion.
 *
 * Codex is a coding agent, not a fixed media-generation API: for a task like
 * "generate an image" it is *asked* to accomplish the goal — using whatever
 * MCP tools or local scripts the user has configured in their own Codex setup
 * — rather than calling one hardcoded endpoint. Results (and whether a given
 * task is possible at all) depend on the user's Codex configuration.
 *
 * Execution: spawns the `codex` binary resolved from PATH (override via
 * CODEX_CLI_PATH) in non-interactive `codex exec` mode. The reply is written
 * to a scratch file via `--output-last-message` so it can be read back even
 * if Codex prints reasoning/tool-call chatter to stdout. Every prompt below
 * ends with an explicit instruction to reply with a single JSON object/array
 * matching a documented shape, parsed leniently (trailing-JSON scan) since
 * models occasionally wrap JSON in prose or a code fence despite instructions.
 *
 * Auth: codexApiKey()/hasCodexAuth() in ./codex-auth. `codex login` manages
 * its own OAuth/API-key flow; when not logged in, hasCodexAuth() returns
 * false and callers fall back to other implementations (e.g. Serper search).
 *
 * NOTE: exact `codex exec` flags (sandbox level, approval mode) can vary
 * across Codex CLI versions. Override them with CODEX_EXEC_ARGS (a
 * space-separated string) if the defaults below don't match your installed
 * version.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COPYRIGHT_HOSTS,
  asRecord,
  codexChildEnv,
  resolveCodexEntry,
  safeHost,
  type ImageSearchResult,
  type WebSearchResult,
} from './shared'

export { resolveCodexEntry } from './shared'
export { hasCodexAuth } from './codex-auth'

const EXEC_TIMEOUT_MS = 120_000
const GENERATE_TIMEOUT_MS = 600_000
const MAX_BUFFER = 32 * 1024 * 1024

// ── CLI resolution & execution ──────────────────────────────────────

function defaultExecArgs(): string[] {
  if (process.env.CODEX_EXEC_ARGS) return process.env.CODEX_EXEC_ARGS.split(' ').filter(Boolean)
  // non-interactive: never pause for approval, full filesystem+network access in the
  // sandbox (search/image-gen/file conversion all need it) — see module doc for how
  // to override this if your Codex CLI version names these flags differently.
  return ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']
}

/**
 * Runs one `codex exec` turn with `prompt`, returning the agent's final
 * message text. Uses --output-last-message so the reply survives any extra
 * chatter Codex prints to stdout while it works.
 */
function runCodex(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const entry = resolveCodexEntry()
  const scratchDir = mkdtempSync(join(tmpdir(), 'genoffice-codex-'))
  const outFile = join(scratchDir, 'reply.txt')
  const args = ['exec', ...defaultExecArgs(), '--output-last-message', outFile, prompt]
  return new Promise((resolve, reject) => {
    execFile(
      entry,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        shell: process.platform === 'win32',
        env: codexChildEnv(),
        ...(signal ? { signal } : {}),
      },
      (err, _stdout, stderr) => {
        try {
          if (err) {
            const errText = (stderr || '').toString().trim().slice(0, 500)
            reject(errText ? new Error(`${err.message} | stderr: ${errText}`) : err)
            return
          }
          try {
            resolve(readFileSync(outFile, 'utf-8'))
          } catch {
            reject(new Error('codex exec produced no output'))
          }
        } finally {
          try {
            rmSync(scratchDir, { recursive: true, force: true })
          } catch {
            /* best-effort cleanup */
          }
        }
      },
    )
  })
}

/**
 * Scans `text` for balanced top-level `{...}` / `[...]` substrings (respecting
 * string literals, so braces inside quoted strings don't throw off the depth
 * count). Used to pull JSON out of prose or a fenced code block.
 */
function balancedJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{' || c === '[') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' || c === ']') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1))
      }
    }
  }
  return candidates
}

/**
 * Codex's final message may wrap the requested JSON in prose or a fenced code
 * block despite instructions; scan for a parseable JSON value, preferring the
 * last one found (models sometimes "think out loud" in JSON fragments before
 * the real answer). (exported for tests)
 */
export function parseCodexOutput(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    /* fall through to scanning */
  }
  const candidates = balancedJsonCandidates(trimmed)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]!)
    } catch {
      continue
    }
  }
  throw new Error(`No JSON found in codex output: ${trimmed.slice(0, 300)}`)
}

async function execJson(
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await runCodex(prompt, timeoutMs, signal)
  return parseCodexOutput(text)
}

// ── Web search ──────────────────────────────────────────────────────

export async function codexWebSearch(
  query: string,
  maxResults = 6,
): Promise<{ results: WebSearchResult[]; answer?: string }> {
  const prompt =
    `Search the web for: ${query}\n` +
    `Reply with ONLY a JSON object of the shape ` +
    `{"results":[{"title":string,"url":string,"snippet":string}],"answer"?:string}, ` +
    `at most ${maxResults} results, no other text.`
  const raw = asRecord(await execJson(prompt, EXEC_TIMEOUT_MS))
  const results: WebSearchResult[] = (Array.isArray(raw.results) ? raw.results : [])
    .slice(0, maxResults)
    .map((item) => {
      const o = asRecord(item)
      return { title: String(o.title ?? ''), url: String(o.url ?? ''), snippet: String(o.snippet ?? '') }
    })
  const answer = typeof raw.answer === 'string' && raw.answer ? raw.answer : undefined
  return answer !== undefined ? { results, answer } : { results }
}

export async function codexImageSearch(
  query: string,
  maxResults = 8,
): Promise<ImageSearchResult[]> {
  const prompt =
    `Search the web for images of: ${query}\n` +
    `Reply with ONLY a JSON array of at most ${maxResults} objects of the shape ` +
    `{"title":string,"imageUrl":string,"sourceUrl":string,"source":string,"width"?:number,"height"?:number}, ` +
    `no other text. Each imageUrl must be a direct, publicly fetchable image URL.`
  const raw = await execJson(prompt, EXEC_TIMEOUT_MS)
  const list: unknown[] = Array.isArray(raw) ? raw : []
  const images: ImageSearchResult[] = []
  for (const item of list) {
    const img = asRecord(item)
    const imageUrl = String(img.imageUrl ?? '')
    if (!imageUrl) continue
    if (COPYRIGHT_HOSTS.some((d) => imageUrl.toLowerCase().includes(d))) continue
    const entry: ImageSearchResult = {
      title: String(img.title ?? ''),
      imageUrl,
      sourceUrl: String(img.sourceUrl ?? ''),
      source: String(img.source ?? safeHost(img.sourceUrl)),
    }
    const width = Number(img.width)
    const height = Number(img.height)
    if (Number.isFinite(width) && width > 0) entry.width = width
    if (Number.isFinite(height) && height > 0) entry.height = height
    images.push(entry)
    if (images.length >= maxResults) break
  }
  return images
}

// ── Image generation ────────────────────────────────────────────────

export interface CodexGenerateImageOptions {
  /** Image description (English works better; text that must appear in the image stays verbatim) */
  prompt: string
  /** Reference/edit-target image local paths or URLs */
  referenceImageUrls?: string[]
  /** 1:1 | 4:3 | 16:9 | 9:16 | 3:4 | 2:3 | 3:2 | auto */
  aspectRatio?: string
}

export interface CodexGeneratedImage {
  /** Local file path of the generated image */
  path: string
}

export async function codexGenerateImage(
  options: CodexGenerateImageOptions,
  signal?: AbortSignal,
): Promise<CodexGeneratedImage> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'genoffice-codex-img-'))
  const outPath = join(scratchDir, 'image.png')
  const parts = [
    `Generate an image and save it to the local file path ${outPath} (create parent dirs as needed).`,
    `Description: ${options.prompt}`,
    options.aspectRatio ? `Aspect ratio: ${options.aspectRatio}` : '',
    options.referenceImageUrls?.length
      ? `Reference/edit-target images: ${options.referenceImageUrls.join(', ')}`
      : '',
    `Use whatever image-generation tool you have available. When done, reply with ONLY ` +
      `{"path":"${outPath}"} and no other text.`,
  ].filter(Boolean)
  const raw = asRecord(await execJson(parts.join('\n'), GENERATE_TIMEOUT_MS, signal))
  const path = String(raw.path ?? outPath)
  return { path }
}

// ── File conversion (PDF -> DOCX) ───────────────────────────────────

/**
 * Converts a local PDF to DOCX in place using Codex's own tools (e.g. a
 * document-conversion MCP server or a local library it can script against),
 * writing the result next to the source file. Returns the DOCX bytes.
 */
export async function codexConvertPdfToDocx(
  filePath: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const outPath = filePath.replace(/\.pdf$/i, '') + '.docx'
  const prompt =
    `Convert the PDF at ${filePath} to a DOCX file, preserving text and layout as closely as ` +
    `possible, and save it to ${outPath}. When done, reply with ONLY {"path":"${outPath}"} and no other text.`
  const raw = asRecord(await execJson(prompt, GENERATE_TIMEOUT_MS, signal))
  const path = String(raw.path ?? outPath)
  return new Uint8Array(readFileSync(path))
}

// ── Media analysis / transcription ──────────────────────────────────

export interface CodexAnalyzeMediaOptions {
  /** Media local paths or URLs (image/audio/video) */
  mediaUrls: string[]
  /** Analysis requirements (in English): what info to extract and what it's for */
  requirements: string
}

export async function codexAnalyzeMedia(
  options: CodexAnalyzeMediaOptions,
  signal?: AbortSignal,
): Promise<string> {
  const prompt =
    `Analyze this media: ${options.mediaUrls.join(', ')}\nRequirements: ${options.requirements}\n` +
    `Reply with ONLY {"text":string} containing your analysis, no other text.`
  const raw = asRecord(await execJson(prompt, GENERATE_TIMEOUT_MS, signal))
  return String(raw.text ?? '')
}

export interface CodexTranscribeOptions {
  /** Audio local paths or URLs */
  audioUrls: string[]
  /** Prompt (context / proper nouns; can improve recognition quality) */
  prompt?: string
}

export async function codexTranscribe(
  options: CodexTranscribeOptions,
  signal?: AbortSignal,
): Promise<string> {
  const prompt =
    `Transcribe this audio: ${options.audioUrls.join(', ')}\n` +
    (options.prompt ? `Context: ${options.prompt}\n` : '') +
    `Reply with ONLY {"text":string} containing the transcript, no other text.`
  const raw = asRecord(await execJson(prompt, GENERATE_TIMEOUT_MS, signal))
  return String(raw.text ?? '')
}

// ── Single-slide generation ─────────────────────────────────────────

export interface CodexSlideGenerateOptions {
  /** Content and layout brief for this page */
  brief: string
  title?: string
  /** Deck-level visual system / typography / palette rules (Style Skill text) */
  styleSkill?: string
  /** Deck topic, page index, total pages, neighboring-page context */
  deckContext?: Record<string, unknown>
  /** Image candidates for this page (local paths or URLs) */
  images?: { url: string; caption?: string }[]
  width?: number
  height?: number
  signal?: AbortSignal
}

/** Generates one editable slide (brief -> a single-slide PPTX file) using Codex's own tools. */
export async function codexSlideGenerate(
  options: CodexSlideGenerateOptions,
): Promise<{ bytes: Uint8Array }> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'genoffice-codex-slide-'))
  const outPath = join(scratchDir, 'slide.pptx')
  const parts = [
    `Create a single-slide .pptx file implementing this brief and save it to ${outPath}.`,
    `Brief: ${options.brief}`,
    options.title ? `Title: ${options.title}` : '',
    options.styleSkill ? `Visual style rules: ${options.styleSkill}` : '',
    options.deckContext ? `Deck context: ${JSON.stringify(options.deckContext)}` : '',
    options.images?.length
      ? `Candidate images: ${options.images.map((i) => i.url).join(', ')}`
      : '',
    options.width && options.height ? `Slide size: ${options.width}x${options.height}` : '',
    `When done, reply with ONLY {"path":"${outPath}"} and no other text.`,
  ].filter(Boolean)
  const raw = asRecord(
    await execJson(parts.join('\n'), GENERATE_TIMEOUT_MS, options.signal),
  )
  const path = String(raw.path ?? outPath)
  return { bytes: new Uint8Array(readFileSync(path)) }
}
