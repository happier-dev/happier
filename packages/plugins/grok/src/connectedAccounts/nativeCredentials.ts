import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import type { XaiCredential } from './credential.js';

// Characterized against xai-org/grok-build crates/codegen/xai-grok-login/src/{model,config,storage}.rs,
// revision 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8 (2026-11-09).
// The native store is an unversioned scope -> GrokAuth map.
export const GROK_XAI_ISSUER = 'https://auth.x.ai';
export const GROK_XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const API_KEY_SCOPE = 'xai::api_key';

const nativeStringFields = ['first_name', 'last_name', 'profile_image_asset_id', 'principal_type', 'principal_id',
  'team_id', 'team_name', 'team_role', 'organization_id', 'organization_name', 'organization_role', 'user_blocked_reason'] as const;
const nativeBooleanFields = ['coding_data_retention_opt_out', 'can_administer_team', 'has_grok_code_access'] as const;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('Unsupported Grok native credential timestamp');
  }
  return Date.parse(value);
}
function nativeFacts(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const native: Record<string, unknown> = {};
  if (row.create_time !== undefined) { timestamp(row.create_time); native.create_time = row.create_time; }
  for (const field of nativeStringFields) {
    if (row[field] === undefined || row[field] === null) continue;
    if (typeof row[field] !== 'string') throw new Error('Unsupported Grok native identity field');
    native[field] = row[field];
  }
  for (const field of nativeBooleanFields) {
    if (row[field] === undefined || row[field] === null) continue;
    if (typeof row[field] !== 'boolean') throw new Error('Unsupported Grok native privacy field');
    native[field] = row[field];
  }
  if (row.team_blocked_reasons !== undefined) {
    if (!Array.isArray(row.team_blocked_reasons) || row.team_blocked_reasons.some(value => typeof value !== 'string')) {
      throw new Error('Unsupported Grok native team policy field');
    }
    native.team_blocked_reasons = row.team_blocked_reasons;
  }
  return native;
}

/** Import only an explicitly resolved first-party scope; never guess among native identities. */
export function parseGrokAuthStore(input: unknown, options: Readonly<{ scope?: string }> = {}): XaiCredential {
  let store: unknown = input;
  if (typeof input === 'string') {
    try { store = JSON.parse(input); }
    catch { throw new Error('Unsupported Grok native auth store'); }
  }
  if (!record(store)) throw new Error('Unsupported Grok native auth store');
  const candidates = Object.keys(store).filter(scope => scope === API_KEY_SCOPE || scope.startsWith(`${GROK_XAI_ISSUER}::`));
  const scope = options.scope ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!scope || !candidates.includes(scope)) throw new Error('Grok native auth scope is ambiguous or unsupported');
  const row = store[scope];
  if (!record(row) || !nonempty(row.key) || typeof row.user_id !== 'string' || !nonempty(row.create_time)) {
    throw new Error('Unsupported Grok native credential schema');
  }
  timestamp(row.create_time);
  const apiKey = scope === API_KEY_SCOPE;
  if (apiKey ? row.auth_mode !== 'api_key' : row.auth_mode !== 'oidc'
    || row.oidc_issuer !== GROK_XAI_ISSUER || !nonempty(row.oidc_client_id)
    || scope !== `${GROK_XAI_ISSUER}::${row.oidc_client_id}`) {
    throw new Error('Unsupported Grok native credential mode or issuer');
  }
  if (row.email !== undefined && row.email !== null && typeof row.email !== 'string') throw new Error('Unsupported Grok native email');
  if (row.refresh_token !== undefined && row.refresh_token !== null && !nonempty(row.refresh_token)) throw new Error('Unsupported Grok native refresh material');
  const expiresAtMs = timestamp(row.expires_at);
  return {
    mode: apiKey ? 'api-key' : 'subscription', accessToken: row.key,
    ...(!apiKey && nonempty(row.refresh_token) ? { refreshToken: row.refresh_token } : {}),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    ...(nonempty(row.user_id) ? { subject: row.user_id } : {}),
    ...(typeof row.email === 'string' ? { email: row.email } : {}),
    ...(!apiKey ? { issuer: GROK_XAI_ISSUER, clientId: row.oidc_client_id as string } : {}),
    native: { ...nativeFacts(row), decoderGeneration: 'scoped-grok-auth-v1',
      sourceRevision: '2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8' },
  };
}

/** The daemon retains refresh custody; native Grok receives only the selected access snapshot. */
export function serializeGrokSelectedAuth(credential: XaiCredential, options: Readonly<{ nowMs?: number }> = {}): string {
  if (!nonempty(credential.accessToken)) throw new Error('Grok selected access material unavailable');
  const apiKey = credential.mode === 'api-key';
  const issuer = credential.issuer ?? GROK_XAI_ISSUER;
  const clientId = credential.clientId ?? GROK_XAI_CLIENT_ID;
  if (!apiKey && (issuer !== GROK_XAI_ISSUER || !nonempty(clientId))) throw new Error('Unsupported Grok selected issuer');
  const native = nativeFacts(credential.native ?? {});
  const row = { ...native, key: credential.accessToken, auth_mode: apiKey ? 'api_key' : 'oidc',
    create_time: native.create_time ?? new Date(options.nowMs ?? Date.now()).toISOString(),
    user_id: credential.subject ?? '', email: credential.email ?? null,
    ...(credential.expiresAtMs === undefined ? {} : { expires_at: new Date(credential.expiresAtMs).toISOString() }),
    ...(!apiKey ? { oidc_issuer: issuer, oidc_client_id: clientId } : {}),
  };
  return JSON.stringify({ [apiKey ? API_KEY_SCOPE : `${issuer}::${clientId}`]: row });
}

/** Explicit native import reads one configured file and never executes a credential command. */
export async function readGrokNativeCredential(options: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>; scope?: string; signal?: AbortSignal;
}> = {}): Promise<XaiCredential> {
  const environment = options.environment ?? process.env;
  const homeDir = resolveHomeDirFromEnvironment(environment);
  const home = environment.GROK_HOME?.trim()
    ? resolveConfiguredPath(environment.GROK_HOME, { homeDir }) : join(homeDir, '.grok');
  const path = environment.GROK_AUTH_PATH?.trim()
    ? resolveConfiguredPath(environment.GROK_AUTH_PATH, { homeDir }) : join(home, 'auth.json');
  const contents = await readFile(path, { encoding: 'utf8', signal: options.signal });
  return parseGrokAuthStore(contents, options);
}
