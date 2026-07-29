import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type DirectSourceValidationResult =
  | Readonly<{ ok: true; source: import('@happier-dev/protocol').ExternalSessionsSource }>
  | Readonly<{ ok: false; error: string; errorCode?: 'invalid_request' | 'agent_unavailable' }>;

export function directSourceValidationError(error: string): DirectSourceValidationResult {
  return { ok: false, error };
}

function expandHomeDirForExternalSessions(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

export function canonicalizeExternalSessionsPath(raw: string): string {
  const resolved = resolve(expandHomeDirForExternalSessions(raw));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function normalizeExternalSessionsUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = '';
  url.search = '';
  const normalized = url.toString().replace(/\/+$/, '');
  return normalized || raw.trim();
}

export function isSafeExternalSessionsConnectedServiceId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}
