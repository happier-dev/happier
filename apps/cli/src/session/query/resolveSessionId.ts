import { SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2 } from '@happier-dev/protocol/sessions/control/contract';

import type { StoredCredentials } from '@/persistence';
import type { SessionSnapshotRefreshReason } from '@/api/session/sessionSnapshotRefreshReason';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  fetchSessionById,
  fetchSessionListQueryPage,
  fetchSessionListPage,
  lookupSessionsByTags,
  resolveSessionDetailAccessProjectionVersion,
  type RawSessionRecord,
} from '@/session/transport/http/sessionsHttp';

export type ResolveSessionIdResult =
  | { ok: true; sessionId: string; rawSession?: RawSessionRecord }
  | { ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] };

type AccountEncryptionModeSource = 'plain' | 'e2ee' | (() => Promise<'plain' | 'e2ee'>);

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

export async function resolveSessionIdOrPrefix(params: Readonly<{
  reason: SessionSnapshotRefreshReason;
  credentials: StoredCredentials;
  idOrPrefix: string;
  /** Host-known exact target, not an interactive tag/prefix selector. */
  exact?: true;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET' | 'POST'; path: string; body?: unknown;
  }>) => Readonly<Record<string, string>> | null;
  signal?: AbortSignal;
  /** Snapshot already bound to this exact Home; absence preserves released detail semantics. */
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  /** Persisted mode or its pending exact-Home read; only legacy metadata lookup consumes it. */
  accountEncryptionMode?: AccountEncryptionModeSource;
}>): Promise<ResolveSessionIdResult> {
  params.signal?.throwIfAborted();
  const input = normalizeIdOrPrefix(params.idOrPrefix);
  if (!input) return { ok: false, code: 'session_not_found' };

  // Prefer exact matches for long inputs, while retaining fallback tag and prefix resolution.
  if (params.exact || input.length >= 12) {
    const exact = await fetchSessionById({
      reason: params.reason,
      token: params.credentials.token,
      sessionId: input,
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
    });
    if (exact) {
      return { ok: true, sessionId: input, rawSession: exact };
    }
    if (params.exact) return { ok: false, code: 'session_not_found' };
  }

  const indexedTagLookup = input.length <= SESSION_LOOKUP_BY_TAGS_TAG_MAX_CODE_UNITS_V2
    ? await lookupSessionsByTags({
        token: params.credentials.token,
        tags: [input],
        ...(params.resolveAuthorizationHeaders
          ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
          : {}),
        ...(params.signal ? { signal: params.signal } : {}),
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
  if (indexedTagLookup?.state === 'unavailable') return { ok: false, code: 'unsupported' };

  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;

  let cursor: string | undefined;
  const prefixMatches = new Set<string>();
  const useCurrentAccessQuery = resolveSessionDetailAccessProjectionVersion({
    serverFeaturesSnapshot: params.serverFeaturesSnapshot,
  }) === 1;

  const recordPrefixMatch = (id: string): ResolveSessionIdResult | null => {
    if (prefixMatches.has(id)) return null;
    prefixMatches.add(id);
    if (prefixMatches.size > 1) {
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
      const page: Awaited<ReturnType<typeof fetchSessionListQueryPage>>
        | Awaited<ReturnType<typeof fetchSessionListPage>> = useCurrentAccessQuery
        ? await fetchSessionListQueryPage({
            token: params.credentials.token,
            query: {
              v: 1,
              storage: archivedOnly ? 'archived' : 'active',
              includeInactive: true,
              scope: 'all_accessible',
              attention: 'any',
              audiences: [],
              tagIds: [],
              limit: 200,
              ...(cursor ? { cursor } : {}),
            },
            ...(params.resolveAuthorizationHeaders
              ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
              : {}),
            ...(params.signal ? { signal: params.signal } : {}),
          })
        : await fetchSessionListPage({
            token: params.credentials.token,
            cursor,
            limit: 200,
            archivedOnly,
            ...(params.resolveAuthorizationHeaders
              ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
              : {}),
            ...(params.signal ? { signal: params.signal } : {}),
          });
      params.signal?.throwIfAborted();
      for (const row of page.sessions) {
        const id = row.id;
        if (id.startsWith(input)) {
          const res = recordPrefixMatch(id);
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
