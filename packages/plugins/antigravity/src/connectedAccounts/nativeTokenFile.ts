import { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/protocol/agents/antigravity/oauth-profile';

export type AgyNativeCredential = Readonly<{
  accessToken: string | null;
  refreshToken: string;
  expiresAt: number | null;
  projectId: string | null;
}>;

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The one codec for native Antigravity credential files. `cli` is the native
 * agy consumer token envelope (`antigravity-cli/antigravity-oauth-token`);
 * `acp` is the retired 1.3.0 server file, read only to import an existing login.
 * File scopes are requested scopes, never grant evidence.
 */
export function parseAgyNativeCredential(value: unknown, source: 'acp' | 'cli'): AgyNativeCredential | null {
  const data = record(value);
  if (!data) return null;
  if (source === 'acp' && (text(data.client_id) !== ANTIGRAVITY_OAUTH_PROFILE.clientId
    || (text(data.token_uri) && text(data.token_uri) !== ANTIGRAVITY_OAUTH_PROFILE.tokenUrl))) return null;
  if (source === 'cli' && data.auth_method !== 'consumer') return null;
  const tokens = source === 'cli' ? record(data.token) : data;
  const refreshToken = text(tokens?.refresh_token);
  if (!tokens || !refreshToken) return null;
  const expiry = text(tokens.expiry);
  const expiresAt = expiry ? Date.parse(expiry) : typeof tokens.expiry_date === 'number' ? tokens.expiry_date : null;
  const accessToken = source === 'acp' ? text(tokens.token) ?? text(tokens.access_token) : text(tokens.access_token);
  return { accessToken, refreshToken, expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null, projectId: text(data.project_id) };
}

/** Encodes the native agy consumer token envelope read by `parseAgyNativeCredential(…, 'cli')`. */
export function encodeAgyNativeCliCredential(input: Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  email: string | null;
  nowMs: number;
}>): Uint8Array {
  const expiry = input.expiresAt !== null && Number.isFinite(input.expiresAt) && input.expiresAt > 0 ? input.expiresAt : null;
  return new TextEncoder().encode(JSON.stringify({
    token: {
      access_token: input.accessToken,
      token_type: 'Bearer',
      refresh_token: input.refreshToken,
      ...(expiry === null ? {} : {
        expiry: new Date(expiry).toISOString(),
        expires_in: Math.max(0, Math.floor((expiry - input.nowMs) / 1000)),
      }),
    },
    auth_method: 'consumer',
    ...(input.email ? { id_token_email: input.email } : {}),
  }));
}

/** Reads a native agy token file's bytes through the shared codec. */
export function decodeAgyNativeCliCredential(bytes: Uint8Array | undefined): AgyNativeCredential | null {
  if (!bytes || bytes.byteLength === 0) return null;
  try { return parseAgyNativeCredential(JSON.parse(new TextDecoder().decode(bytes)), 'cli'); }
  catch { return null; }
}
