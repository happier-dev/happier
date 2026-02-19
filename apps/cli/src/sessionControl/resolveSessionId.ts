import type { Credentials } from '@/persistence';
import { fetchSessionById, fetchSessionsPage } from './sessionsHttp';
import { tryDecryptSessionMetadata } from './sessionEncryptionContext';

export type ResolveSessionIdResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] };

function normalizeIdOrPrefix(value: string): string {
  return value.trim();
}

export async function resolveSessionIdOrPrefix(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
}>): Promise<ResolveSessionIdResult> {
  const input = normalizeIdOrPrefix(params.idOrPrefix);
  if (!input) return { ok: false, code: 'session_not_found' };

  // Fast path: if the input is a full session id, prefer exact match over prefix paging.
  // If the session is not found, fall back to prefix+tag resolution.
  if (input.length >= 12) {
    const exact = await fetchSessionById({ token: params.credentials.token, sessionId: input });
    if (exact) {
      return { ok: true, sessionId: input };
    }
  }

  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;

  let cursor: string | undefined;
  const matches: string[] = [];

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200 });
    for (const row of page.sessions) {
      const id = typeof (row as any)?.id === 'string' ? String((row as any).id) : '';
      if (id.startsWith(input)) {
        matches.push(id);
        if (matches.length > 1) {
          return { ok: false, code: 'session_id_ambiguous', candidates: matches.slice(0, 10) };
        }
      }

      // Also support resolving by exact tag match when metadata is decryptable.
      const meta = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: row });
      const tag = typeof (meta as any)?.tag === 'string' ? String((meta as any).tag).trim() : '';
      if (tag && tag === input) {
        matches.push(id);
        if (matches.length > 1) {
          return { ok: false, code: 'session_id_ambiguous', candidates: matches.slice(0, 10) };
        }
      }
    }
    if (!page.hasNext || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  if (matches.length === 1) return { ok: true, sessionId: matches[0]! };
  if (matches.length === 0) return { ok: false, code: 'session_not_found' };
  return { ok: false, code: 'session_id_ambiguous', candidates: matches.slice(0, 10) };
}
