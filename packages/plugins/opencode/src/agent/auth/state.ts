import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';

type Env = Readonly<Record<string, string | undefined>>;

type OpenCodeAuthFile = Readonly<{
  openai?: unknown;
}>;

type OpenCodeOauthAuthEntry = Readonly<{
  refresh?: unknown;
}>;

export type OpenCodeOauthRefreshTokenProbeState = 'valid' | 'invalid' | 'unknown';

export type OpenCodeOauthRefreshTokenProbeResponse = Readonly<{
  ok: boolean;
  status: number;
}>;

export type OpenCodeOauthRefreshTokenFetch = (
  url: string,
  init: Readonly<{
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: URLSearchParams;
    signal: AbortSignal;
  }>,
) => Promise<OpenCodeOauthRefreshTokenProbeResponse>;

const DEFAULT_OPENCODE_OAUTH_REFRESH_TOKEN_PROBE_TIMEOUT_MS = 6000;

function resolveHomeDir(homeDir: string | (() => string) | undefined): string {
  if (typeof homeDir === 'function') return homeDir();
  if (typeof homeDir === 'string' && homeDir.trim().length > 0) return homeDir;
  return homedir();
}

export function resolveOpenCodeAuthJsonPath(params: Readonly<{
  env?: Env;
  homeDir?: string | (() => string);
}> = {}): string {
  const env = params.env ?? process.env;
  const xdgDataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME.trim()
    : join(resolveHomeDir(params.homeDir), '.local', 'share');
  return join(xdgDataHome, 'opencode', 'auth.json');
}

export function resolveOpenCodeOauthRefreshTokenProbeTimeoutMs(env: Env = process.env): number {
  const raw = env.HAPPIER_OPENCODE_OAUTH_REFRESH_TOKEN_PROBE_TIMEOUT_MS;
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  return DEFAULT_OPENCODE_OAUTH_REFRESH_TOKEN_PROBE_TIMEOUT_MS;
}

export function readOpenCodeOauthRefreshToken(params: Readonly<{
  env?: Env;
  homeDir?: string | (() => string);
  readFile?: (path: string, encoding: BufferEncoding) => string;
}> = {}): string | null {
  const readFile = params.readFile ?? readFileSync;
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFile(resolveOpenCodeAuthJsonPath(params), 'utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as OpenCodeAuthFile;
  if (!record.openai || typeof record.openai !== 'object' || Array.isArray(record.openai)) return null;

  const openai = record.openai as OpenCodeOauthAuthEntry;
  const refreshToken = typeof openai.refresh === 'string' ? openai.refresh.trim() : '';
  return refreshToken.length > 0 ? refreshToken : null;
}

function resolveFetch(fetchOpenAiToken?: OpenCodeOauthRefreshTokenFetch): OpenCodeOauthRefreshTokenFetch | null {
  if (fetchOpenAiToken) return fetchOpenAiToken;
  if (typeof globalThis.fetch !== 'function') return null;
  return async (url, init) => {
    const response = await globalThis.fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
    };
  };
}

export async function probeOpenAiCodexOauthRefreshToken(
  refreshToken: string,
  params: Readonly<{
    tokenUrl: string;
    clientId: string;
    fetchOpenAiToken?: OpenCodeOauthRefreshTokenFetch;
    env?: Env;
  }>,
): Promise<OpenCodeOauthRefreshTokenProbeState> {
  const trimmed = refreshToken.trim();
  if (!trimmed) return 'invalid';

  const fetchOpenAiToken = resolveFetch(params.fetchOpenAiToken);
  if (!fetchOpenAiToken) return 'unknown';

  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    resolveOpenCodeOauthRefreshTokenProbeTimeoutMs(params.env ?? process.env),
  );

  try {
    const response = await fetchOpenAiToken(params.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: params.clientId,
        refresh_token: trimmed,
      }),
      signal: controller.signal,
    }).catch(() => null);

    if (!response) return 'unknown';
    if (response.ok) return 'valid';
    if (response.status === 400 || response.status === 401) return 'invalid';
    return 'unknown';
  } finally {
    clearTimeout(timeoutHandle);
  }
}
