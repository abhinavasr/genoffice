/** Search result types and shared constants (used by both the index and the codex backend) */

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface ImageSearchResult {
  title: string
  imageUrl: string
  sourceUrl: string
  source: string
  width?: number
  height?: number
}

// Known stock-photo hosts skipped during image search (matches the upstream filter list)
export const COPYRIGHT_HOSTS = ['gettyimages', 'istockphoto', 'shutterstock', 'corbis']

export function safeHost(url: unknown): string {
  try {
    return new URL(String(url)).hostname
  } catch {
    return ''
  }
}

/**
 * View untrusted JSON as a string-keyed record so properties can be probed
 * without `any`; non-object inputs read as an empty record.
 */
export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

/** First element when the value is an array, otherwise undefined (loose JSON probing). */
export function firstItem(v: unknown): unknown {
  return Array.isArray(v) ? (v as unknown[])[0] : undefined
}

/** Path/name of the `codex` executable. Override via CODEX_CLI_PATH. */
export function resolveCodexEntry(): string {
  return process.env.CODEX_CLI_PATH || 'codex'
}

/**
 * env for spawned `codex` processes: forwards the proxy registered by the
 * apps' proxy bootstraps (codex reads standard proxy env vars itself).
 */
export function codexChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const proxy = [
    aiCliProxyUrl(),
    base.HTTPS_PROXY,
    base.https_proxy,
    base.HTTP_PROXY,
    base.http_proxy,
    base.ALL_PROXY,
    base.all_proxy,
  ].find((v) => v && /^https?:\/\//.test(v))
  if (proxy) {
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
  }
  return env
}

let explicitProxyUrl = ''

/**
 * Proxy resolved by the apps' proxy bootstraps (env vars, else the system
 * proxy via session.resolveProxy); consumed by codexChildEnv() and the login
 * flow's proxy fallback.
 */
export function setAiCliProxyUrl(url: string): void {
  explicitProxyUrl = url
}

export function aiCliProxyUrl(): string {
  return explicitProxyUrl
}
