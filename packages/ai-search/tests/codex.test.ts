import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { parseCodexOutput } from '../src/codex'

describe('parseCodexOutput', () => {
  it('parses clean JSON', () => {
    expect(parseCodexOutput('{"results":[]}')).toEqual({ results: [] })
  })

  it('extracts JSON preceded and followed by prose', () => {
    const out = 'Sure, here you go:\n{"results":[{"title":"A"}]}\nLet me know if you need more.'
    expect(parseCodexOutput(out)).toEqual({ results: [{ title: 'A' }] })
  })

  it('extracts JSON from a fenced code block', () => {
    const out = '```json\n{"path":"/tmp/x.png"}\n```'
    expect(parseCodexOutput(out)).toEqual({ path: '/tmp/x.png' })
  })

  it('extracts a JSON array', () => {
    const out = 'Results:\n[{"title":"A","imageUrl":"https://a.com/x.jpg"}]'
    expect(parseCodexOutput(out)).toEqual([{ title: 'A', imageUrl: 'https://a.com/x.jpg' }])
  })

  it('throws when no JSON is present', () => {
    expect(() => parseCodexOutput('no json here at all')).toThrow(/No JSON found/)
  })
})

// runCodex() spawns the real `codex` binary via execFile and reads back
// --output-last-message; mock execFile to write canned output to that file
// instead, so the higher-level parsers can be exercised without a real CLI.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const outIdx = args.indexOf('--output-last-message')
        const outFile = args[outIdx + 1]!
        writeFileSync(outFile, (globalThis as { __codexReply?: string }).__codexReply ?? '{}')
        cb(null, '', '')
      },
    ),
  }
})

function setReply(text: string): void {
  ;(globalThis as { __codexReply?: string }).__codexReply = text
}

afterEach(() => {
  delete (globalThis as { __codexReply?: string }).__codexReply
})

describe('codexWebSearch', () => {
  it('maps results and respects maxResults', async () => {
    const { codexWebSearch } = await import('../src/codex')
    setReply(
      JSON.stringify({
        results: [
          { title: 'A', url: 'https://a.com', snippet: 'sa' },
          { title: 'B', url: 'https://b.com', snippet: 'sb' },
          { title: 'C', url: 'https://c.com', snippet: 'sc' },
        ],
      }),
    )
    const r = await codexWebSearch('query', 2)
    expect(r.results).toEqual([
      { title: 'A', url: 'https://a.com', snippet: 'sa' },
      { title: 'B', url: 'https://b.com', snippet: 'sb' },
    ])
  })
})

describe('codexImageSearch', () => {
  it('filters copyright hosts and entries without a URL', async () => {
    const { codexImageSearch } = await import('../src/codex')
    setReply(
      JSON.stringify([
        { title: 'ok', imageUrl: 'https://ok.com/a.jpg', sourceUrl: 'https://ok.com' },
        { title: 'getty', imageUrl: 'https://media.gettyimages.com/x.jpg' },
        { title: 'no-url' },
      ]),
    )
    const images = await codexImageSearch('cats', 8)
    expect(images.map((i) => i.title)).toEqual(['ok'])
  })
})
