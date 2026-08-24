import { SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchSessionById,
  fetchSessionsPage,
  lookupSessionsByTags,
  type RawSessionRecord,
} from '@/session/transport/http/sessionsHttp';

export type ResolveSessionIdResult =
  | { ok: true; sessionId: string; rawSession?: RawSessionRecord }
  | { ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] };

const FULL_SESSION_ID_LOOKUP_TIMEOUT_MS = 25_000;

function normalizeIdOrPrefix(value: string): string {
  return value.trim();
}

export function isFullSessionId(value: string): boolean {
  return /^c[a-z0-9]{24}$/.test(value);
}

export type SessionSelectorListPage = Readonly<{
  sessions: readonly Readonly<{ id: string; tag?: string }>[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

export async function resolveSessionIdOrPrefixFromSessionList(params: Readonly<{
  idOrPrefix: string;
  listPage: (input: Readonly<{
    cursor?: string;
    limit: number;
    archivedOnly: boolean;
  }>) => Promise<SessionSelectorListPage>;
  signal?: AbortSignal;
}>): Promise<ResolveSessionIdResult> {
  params.signal?.throwIfAborted();
  const input = normalizeIdOrPrefix(params.idOrPrefix);
  if (!input) return { ok: false, code: 'session_not_found' };
  if (isFullSessionId(input)) return { ok: true, sessionId: input };

  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;
  const prefixMatches = new Set<string>();
  const tagMatches = new Set<string>();

  for (const archivedOnly of [false, true]) {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      params.signal?.throwIfAborted();
      const page = await params.listPage({
        limit: 200,
        archivedOnly,
        ...(cursor ? { cursor } : {}),
      });
      params.signal?.throwIfAborted();
      for (const session of page.sessions) {
        const id = session.id.trim();
        if (!id) continue;
        // Preserve the existing resolver's exact-match precedence for long
        // selectors while full canonical ids avoid lookup altogether.
        if (id === input) return { ok: true, sessionId: id };
        if (id.startsWith(input)) prefixMatches.add(id);
        if (session.tag?.trim() === input) tagMatches.add(id);
      }
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  if (tagMatches.size === 1) {
    return { ok: true, sessionId: Array.from(tagMatches)[0]! };
  }
  if (tagMatches.size > 1) {
    return {
      ok: false,
      code: 'session_id_ambiguous',
      candidates: Array.from(tagMatches).slice(0, 10),
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

async function resolveSessionIdOrPrefixWithSignal(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<ResolveSessionIdResult> {
  params.signal?.throwIfAborted();
  const input = normalizeIdOrPrefix(params.idOrPrefix);
  if (!input) return { ok: false, code: 'session_not_found' };

  // Prefer exact matches for long inputs, while retaining fallback tag and prefix resolution.
  if (input.length >= 12) {
    const exact = await fetchSessionById({
      token: params.credentials.token,
      sessionId: input,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.deadlineAtMs !== undefined ? { deadlineAtMs: params.deadlineAtMs } : {}),
    });
    if (exact) {
      return { ok: true, sessionId: input, rawSession: exact };
    }
  }

  const indexedTagLookup = input.length <= SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2
    ? await lookupSessionsByTags({
        token: params.credentials.token,
        tags: [input],
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.deadlineAtMs !== undefined ? { deadlineAtMs: params.deadlineAtMs } : {}),
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
      params.signal?.throwIfAborted();
      const page = await fetchSessionsPage({
        token: params.credentials.token,
        cursor,
        limit: 200,
        archivedOnly,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      params.signal?.throwIfAborted();
      for (const row of page.sessions) {
        const id = row.id;
        if (id.startsWith(input)) {
          const res = recordPrefixMatch(id);
          if (res) return res;
        }

        if (useOldServerTagFallback) {
          // Old servers predate the owner envelope, so their tag fallback reads the
          // Session-scoped metadata field rather than inferring Account ownership.
          const metadata = tryDecryptSessionMetadata({
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

export async function resolveSessionIdOrPrefix(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  signal?: AbortSignal;
}>): Promise<ResolveSessionIdResult> {
  params.signal?.throwIfAborted();
  const input = normalizeIdOrPrefix(params.idOrPrefix);

  // Built-in tool calls supply server-issued full ids and have a 30s outer budget. Keep
  // existing prefix/tag lookup behavior unchanged; those interactive searches have no
  // equivalent owner deadline and may legitimately require the configured page scan.
  if (!isFullSessionId(input)) return await resolveSessionIdOrPrefixWithSignal(params);

  const controller = new AbortController();
  const deadlineAtMs = Date.now() + FULL_SESSION_ID_LOOKUP_TIMEOUT_MS;
  let didLookupTimeout = false;
  const timeout = setTimeout(() => {
    didLookupTimeout = true;
    controller.abort();
  }, FULL_SESSION_ID_LOOKUP_TIMEOUT_MS);
  timeout.unref();

  const abortFromCaller = () => {
    clearTimeout(timeout);
    controller.abort(params.signal?.reason);
  };
  params.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    return await resolveSessionIdOrPrefixWithSignal({
      ...params,
      idOrPrefix: input,
      signal: controller.signal,
      deadlineAtMs,
    });
  } catch (error) {
    if (didLookupTimeout || Date.now() >= deadlineAtMs) {
      return { ok: false, code: 'session_lookup_timeout' };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', abortFromCaller);
  }
}
