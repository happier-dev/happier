import { SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchSessionById,
  fetchSessionsPage,
  lookupSessionsByTags,
  type RawSessionRecord,
} from '@/session/transport/http/sessionsHttp';

export type ResolveSessionIdResult =
  | { ok: true; sessionId: string; rawSession?: RawSessionRecord }
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
      return { ok: true, sessionId: input, rawSession: exact };
    }
  }

  const indexedTagLookup = input.length <= SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2
    ? await lookupSessionsByTags({
        token: params.credentials.token,
        tags: [input],
      })
    : null;
  if (indexedTagLookup?.state === 'available') {
    const indexedMatches = new Map(
      indexedTagLookup.sessions.map((session) => [session.id, session]),
    );
    if (indexedMatches.size === 1) {
      const rawSession = indexedMatches.values().next().value;
      if (rawSession) {
        return { ok: true, sessionId: rawSession.id, rawSession };
      }
    }
    if (indexedMatches.size > 1) {
      return {
        ok: false,
        code: 'session_id_ambiguous',
        candidates: Array.from(indexedMatches.keys()).slice(0, 10),
      };
    }
  }

  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;

  let cursor: string | undefined;
  const prefixMatches = new Set<string>();
  const fallbackTagMatches = new Set<string>();
  const useOldServerTagFallback = indexedTagLookup?.state === 'unavailable';

  const recordPrefixMatch = (id: string): ResolveSessionIdResult | null => {
    if (prefixMatches.has(id)) return null;
    prefixMatches.add(id);
    if (!useOldServerTagFallback && prefixMatches.size > 1) {
      return {
        ok: false,
        code: 'session_id_ambiguous',
        candidates: Array.from(prefixMatches).slice(0, 10),
      };
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
          const res = recordPrefixMatch(id);
          if (res) return res;
        }

        if (useOldServerTagFallback) {
          const metadata = tryDecryptSessionOwnerMetadataView({
            credentials: params.credentials,
            rawSession: row,
          });
          const tag = typeof metadata?.tag === 'string' ? metadata.tag.trim() : '';
          if (tag === input) {
            fallbackTagMatches.add(id);
          }
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

  if (fallbackTagMatches.size === 1) {
    return { ok: true, sessionId: Array.from(fallbackTagMatches)[0]! };
  }
  if (fallbackTagMatches.size > 1) {
    return {
      ok: false,
      code: 'session_id_ambiguous',
      candidates: Array.from(fallbackTagMatches).slice(0, 10),
    };
  }
  if (prefixMatches.size === 1) {
    return { ok: true, sessionId: Array.from(prefixMatches)[0]! };
  }
  if (prefixMatches.size === 0) return { ok: false, code: 'session_not_found' };
  return {
    ok: false,
    code: 'session_id_ambiguous',
    candidates: Array.from(prefixMatches).slice(0, 10),
  };
}
