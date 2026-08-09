/**
 * OpenAI Codex CLI auth: unlike Genspark's gsk (an HTTP device-code flow this
 * app implemented itself), Codex CLI owns its own login — `codex login`
 * spawns the browser OAuth (or accepts an API key) and persists credentials
 * itself, conventionally at ~/.codex/auth.json. This module just shells out
 * to `codex login`/`codex logout` and reports on that file's presence.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { asRecord, codexChildEnv, resolveCodexEntry } from './shared'

const LOGIN_TIMEOUT_MS = 5 * 60_000

/** Progress event for the browser login flow. */
export interface CodexLoginProgress {
  phase: 'url' | 'success' | 'error'
  url?: string
  /** 'network' | raw error text */
  error?: string
}

/** Override dir via CODEX_AUTH_DIR (test isolation). */
export function codexAuthPath(): string {
  return join(process.env.CODEX_AUTH_DIR || join(homedir(), '.codex'), 'auth.json')
}

interface CodexAuth {
  email?: string
  raw: Record<string, unknown>
}

let cachedAuth: CodexAuth | null | undefined

function extractEmail(raw: Record<string, unknown>): string | undefined {
  for (const key of ['email', 'user_email']) {
    if (typeof raw[key] === 'string' && raw[key]) return raw[key] as string
  }
  const account = asRecord(raw.account ?? raw.user)
  return typeof account.email === 'string' && account.email ? account.email : undefined
}

function readAuthFile(): CodexAuth | null {
  try {
    const raw = asRecord(JSON.parse(readFileSync(codexAuthPath(), 'utf-8')))
    if (Object.keys(raw).length === 0) return null
    const email = extractEmail(raw)
    return email ? { email, raw } : { raw }
  } catch {
    return null
  }
}

export function loadCodexAuth(): CodexAuth | null {
  if (cachedAuth === undefined) cachedAuth = readAuthFile()
  return cachedAuth
}

/** Whether Codex is usable (CLI available and logged in / has a key). Callers use this to decide fallback. */
export function hasCodexAuth(): boolean {
  if (process.env.AI_SEARCH_DISABLE_CODEX === '1') return false
  if (process.env.CODEX_API_KEY) return true
  return loadCodexAuth() !== null
}

/** Best-effort email for the signed-in Codex account, if the auth file exposes one. */
export function codexAccountEmail(): string | undefined {
  return loadCodexAuth()?.email
}

// ── Login / logout ──────────────────────────────────────────────────

let activeLogin: { child: ChildProcess; cancel: () => void } | null = null

/**
 * Starts `codex login`, cancelling a previous in-flight one. Emits a `url`
 * event when Codex prints a browser sign-in link to stdout/stderr (the
 * caller opens it in the system browser), then `success`/`error` when the
 * process exits.
 */
export function startCodexLogin(onEvent?: (progress: CodexLoginProgress) => void): boolean {
  activeLogin?.cancel()
  const emit = onEvent ?? (() => {})
  let urlEmitted = false
  let done = false
  let output = ''

  const child = spawn(resolveCodexEntry(), ['login'], {
    shell: process.platform === 'win32',
    timeout: LOGIN_TIMEOUT_MS,
    env: codexChildEnv(),
  })
  const self = {
    child,
    cancel: () => {
      done = true
      child.kill()
    },
  }
  activeLogin = self

  const onChunk = (chunk: Buffer) => {
    output += chunk.toString()
    if (urlEmitted || done) return
    const match = /https?:\/\/\S+/.exec(output)
    if (match) {
      urlEmitted = true
      emit({ phase: 'url', url: match[0] })
    }
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)

  child.on('error', (err) => {
    if (done) return
    done = true
    if (activeLogin === self) activeLogin = null
    emit({ phase: 'error', error: err.message || 'network' })
  })
  child.on('close', (code) => {
    if (done) return
    done = true
    if (activeLogin === self) activeLogin = null
    cachedAuth = undefined
    if (code === 0) {
      emit({ phase: 'success' })
    } else {
      emit({ phase: 'error', error: output.trim().slice(-500) || `codex login exited ${code}` })
    }
  })

  return true
}

/** True while a login started via startCodexLogin is in flight. */
export function codexLoginInFlight(): boolean {
  return activeLogin !== null
}

/**
 * Fire-and-forget login for entry points without progress UI. Reuses an
 * in-flight flow (restarting would strand the user mid-browser-flow);
 * openUrl is the caller's browser opener (this module is Electron-free).
 */
export function ensureCodexLogin(openUrl: (url: string) => void): void {
  if (codexLoginInFlight()) return
  startCodexLogin((progress) => {
    if (progress.url) openUrl(progress.url)
  })
}

/** Signs out of Codex: `codex logout` (best-effort), then clears the local cache. */
export async function codexLogout(): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(
      resolveCodexEntry(),
      ['logout'],
      { shell: process.platform === 'win32', timeout: 30_000, env: codexChildEnv() },
      () => resolve(), // best-effort — local cache reset below is the contract
    )
  })
  try {
    if (existsSync(codexAuthPath())) unlinkSync(codexAuthPath())
  } catch {
    /* local sign-out must not throw */
  }
  cachedAuth = null
}

/** Test hook: drop the auth cache. */
export function resetCodexAuthCache(): void {
  cachedAuth = undefined
}
