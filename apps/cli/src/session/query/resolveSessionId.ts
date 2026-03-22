import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById, fetchSessionsPage } from '@/session/transport/http/sessionsHttp';

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
  const matches = new Set<string>();

  const recordMatch = (id: string): ResolveSessionIdResult | null => {
    if (matches.has(id)) return null;
    matches.add(id);
    if (matches.size > 1) {
      return { ok: false, code: 'session_id_ambiguous', candidates: Array.from(matches).slice(0, 10) };
    }
    return null;
  };

  const scan = async (archivedOnly: boolean): Promise<ResolveSessionIdResult | null> => {
    cursor = undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200, archivedOnly });
      for (const row of page.sessions) {
        const id = row.id;
        if (id.startsWith(input)) {
          const res = recordMatch(id);
          if (res) return res;
        }

        // Also support resolving by exact tag match when metadata is decryptable.
        const meta = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: row });
        const tag = meta && typeof meta.tag === 'string' ? meta.tag.trim() : '';
        if (tag && tag === input) {
          const res = recordMatch(id);
          if (res) return res;
        }
      }
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return null;
  };

  const activeScan = await scan(false);
  if (activeScan) return activeScan;
  const archivedScan = await scan(true);
  if (archivedScan) return archivedScan;

  if (matches.size === 1) return { ok: true, sessionId: Array.from(matches)[0]! };
  if (matches.size === 0) return { ok: false, code: 'session_not_found' };
  return { ok: false, code: 'session_id_ambiguous', candidates: Array.from(matches).slice(0, 10) };
}
