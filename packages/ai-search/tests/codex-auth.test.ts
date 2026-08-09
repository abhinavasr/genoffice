import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(): void {
    this.killed = true
  }
}

let fakeChild: FakeChild
const spawnMock = vi.fn(() => fakeChild)
const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: () => void) => {
  cb()
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock, execFile: execFileMock }
})

let dir: string

beforeEach(() => {
  fakeChild = new FakeChild()
  dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
  process.env.CODEX_AUTH_DIR = dir
  delete process.env.CODEX_API_KEY
  spawnMock.mockClear()
  execFileMock.mockClear()
})

afterEach(async () => {
  const { resetCodexAuthCache } = await import('../src/codex-auth')
  resetCodexAuthCache()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CODEX_AUTH_DIR
  delete process.env.CODEX_API_KEY
})

describe('hasCodexAuth', () => {
  it('is false with no key and no auth file', async () => {
    const { hasCodexAuth, resetCodexAuthCache } = await import('../src/codex-auth')
    resetCodexAuthCache()
    expect(hasCodexAuth()).toBe(false)
  })

  it('is true when CODEX_API_KEY is set', async () => {
    process.env.CODEX_API_KEY = 'sk-codex-x'
    const { hasCodexAuth, resetCodexAuthCache } = await import('../src/codex-auth')
    resetCodexAuthCache()
    expect(hasCodexAuth()).toBe(true)
  })

  it('is true when the auth file has content', async () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ email: 'me@example.com' }))
    const { hasCodexAuth, codexAccountEmail, resetCodexAuthCache } = await import('../src/codex-auth')
    resetCodexAuthCache()
    expect(hasCodexAuth()).toBe(true)
    expect(codexAccountEmail()).toBe('me@example.com')
  })
})

describe('startCodexLogin', () => {
  it('emits a url when codex prints a sign-in link, then success on clean exit', async () => {
    const { startCodexLogin, codexLoginInFlight } = await import('../src/codex-auth')
    const events: Array<{ phase: string; url?: string; error?: string }> = []
    startCodexLogin((p) => events.push(p))
    expect(codexLoginInFlight()).toBe(true)
    fakeChild.stdout.emit('data', Buffer.from('Sign in at https://auth.openai.com/device?x=1 to continue\n'))
    fakeChild.emit('close', 0)
    expect(events).toEqual([
      { phase: 'url', url: 'https://auth.openai.com/device?x=1' },
      { phase: 'success' },
    ])
    expect(codexLoginInFlight()).toBe(false)
  })

  it('reports a non-zero exit as an error', async () => {
    const { startCodexLogin } = await import('../src/codex-auth')
    const events: Array<{ phase: string; error?: string }> = []
    startCodexLogin((p) => events.push(p))
    fakeChild.stderr.emit('data', Buffer.from('not logged in: network error'))
    fakeChild.emit('close', 1)
    expect(events).toEqual([{ phase: 'error', error: 'not logged in: network error' }])
  })

  it('cancels a previous in-flight login when a new one starts', async () => {
    const { startCodexLogin } = await import('../src/codex-auth')
    startCodexLogin(() => {})
    const firstChild = fakeChild
    fakeChild = new FakeChild()
    startCodexLogin(() => {})
    expect(firstChild.killed).toBe(true)
  })
})

describe('codexLogout', () => {
  it('runs `codex logout` and removes the local auth file', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ email: 'me@example.com' }))
    const { codexLogout, hasCodexAuth, resetCodexAuthCache } = await import('../src/codex-auth')
    resetCodexAuthCache()
    expect(hasCodexAuth()).toBe(true)
    await codexLogout()
    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['logout'],
      expect.anything(),
      expect.anything(),
    )
    expect(hasCodexAuth()).toBe(false)
  })

  it('is a no-op-safe when not signed in', async () => {
    const { codexLogout } = await import('../src/codex-auth')
    await expect(codexLogout()).resolves.toBeUndefined()
  })
})
