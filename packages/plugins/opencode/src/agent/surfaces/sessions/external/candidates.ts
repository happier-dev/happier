import {
  compareExternalSessionCandidatePrecedence,
  type AgentExternalSessionCandidate,
  type AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  buildOpenCodeAgentRuntimeDescriptorV1,
  type OpenCodeAgentRuntimeDescriptorV1,
} from '../../../identity/runtimeDescriptor.js';
import {
  asRecord,
  normalizeString,
  readNonBlankOpaqueIdentifier,
} from '../../../runtime/server/openCodeParsing.js';
import type { OpenCodeServerDialect } from '../../../runtime/server/dialect.js';
import {
  createOpenCodeExternalSessionClient,
  type OpenCodeExternalSessionClient,
  type OpenCodeExternalSessionSource,
} from './client.js';

function getString(value: unknown, key: string): string {
  const record = asRecord(value);
  return normalizeString(record?.[key]);
}

function getNumber(value: unknown, key: string): number | null {
  const record = asRecord(value);
  const raw = record ? record[key] : null;
  return typeof raw === 'number'
    && Number.isSafeInteger(raw)
    && raw >= 0
    && raw < Number.MAX_SAFE_INTEGER
    ? raw
    : null;
}

function getNestedNumber(value: unknown, parentKey: string, key: string): number | null {
  const record = asRecord(value);
  return getNumber(record?.[parentKey], key);
}

export function parseOpenCodeSessionCandidate(raw: unknown): AgentExternalSessionCandidate | null {
  const record = asRecord(raw);
  if (!record) return null;
  // OpenCode minted this session id and the host resumes it verbatim; only the
  // human-facing title is Happier-canonicalized.
  const remoteSessionId = readNonBlankOpaqueIdentifier(record.id);
  if (!remoteSessionId) return null;

  const title = getString(record, 'title');
  const updatedAtMs = getNumber(record, 'updatedAtMs')
    ?? getNumber(record, 'updatedAt')
    ?? getNestedNumber(record, 'time', 'updated')
    ?? null;
  if (updatedAtMs === null) return null;

  return {
    remoteSessionId,
    ...(title ? { title } : {}),
    updatedAtMs,
  };
}

export type OpenCodeExternalSessionCandidate = AgentExternalSessionCandidate & Readonly<{
  runtimeDescriptor: OpenCodeAgentRuntimeDescriptorV1;
}>;

const OPENCODE_CANDIDATE_CURSOR_PREFIX = 'happier_opencode_candidate_scan_v1:';
const OPENCODE_CANDIDATE_CURSOR_MAX_LENGTH = 4_096;

/**
 * A continuation of the timestamp-anchored walk over V1's
 * `/experimental/session`: the anchor is re-read on the next page, which is what
 * lets a moved source be detected and a full-search page resume inside a group
 * of sessions sharing one update time.
 */
type OpenCodeCandidateAnchorCursor = Readonly<{
  v: 1;
  kind: 'opencodeCandidateScan';
  searchMode: 'fast' | 'full';
  searchTerm: string;
  scanned: number;
  anchor: Readonly<{
    remoteSessionId: string;
    updatedAtMs: number;
    offsetWithinTimestamp: number;
  }>;
}>;

/**
 * A continuation of V2's `/api/session`, which offers only an opaque
 * server-minted token. The token carries its own query and the server resumes
 * strictly after the page it was minted from, so there is no anchor to re-read
 * and no offset to carry.
 */
type OpenCodeCandidateSourceTokenCursor = Readonly<{
  v: 2;
  kind: 'opencodeCandidateScan';
  searchMode: 'fast' | 'full';
  searchTerm: string;
  scanned: number;
  sourceCursor: string;
}>;

type OpenCodeCandidateCursor =
  | OpenCodeCandidateAnchorCursor
  | OpenCodeCandidateSourceTokenCursor;

type OpenCodeCandidateQuery = Readonly<{
  searchMode: 'fast' | 'full';
  searchTerm: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function readOpenCodeCandidateCursor(value: string): OpenCodeCandidateCursor | null {
  if (
    !value.startsWith(OPENCODE_CANDIDATE_CURSOR_PREFIX)
    || value.length > OPENCODE_CANDIDATE_CURSOR_MAX_LENGTH
  ) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(OPENCODE_CANDIDATE_CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as unknown;
    if (!isRecord(parsed)) return null;
    if (
      parsed.kind !== 'opencodeCandidateScan'
      || (parsed.searchMode !== 'fast' && parsed.searchMode !== 'full')
      || typeof parsed.searchTerm !== 'string'
      || parsed.searchTerm.length > OPENCODE_CANDIDATE_CURSOR_MAX_LENGTH
      || !Number.isSafeInteger(parsed.scanned)
      || (parsed.scanned as number) < 0
    ) return null;
    if (parsed.v === 2) {
      if (
        !hasExactKeys(parsed, ['kind', 'scanned', 'searchMode', 'searchTerm', 'sourceCursor', 'v'])
        || typeof parsed.sourceCursor !== 'string'
        || parsed.sourceCursor.trim().length < 1
        || parsed.sourceCursor.length > OPENCODE_CANDIDATE_CURSOR_MAX_LENGTH
      ) return null;
      return {
        v: 2,
        kind: 'opencodeCandidateScan',
        searchMode: parsed.searchMode,
        searchTerm: parsed.searchTerm,
        scanned: parsed.scanned as number,
        sourceCursor: parsed.sourceCursor,
      };
    }
    if (!hasExactKeys(parsed, ['anchor', 'kind', 'scanned', 'searchMode', 'searchTerm', 'v'])) {
      return null;
    }
    if (
      parsed.v !== 1
      // The anchored walk has always scanned at least the anchor itself.
      || (parsed.scanned as number) < 1
      || !isRecord(parsed.anchor)
      || !hasExactKeys(parsed.anchor, ['offsetWithinTimestamp', 'remoteSessionId', 'updatedAtMs'])
      || typeof parsed.anchor.remoteSessionId !== 'string'
      || parsed.anchor.remoteSessionId.length < 1
      || !Number.isSafeInteger(parsed.anchor.updatedAtMs)
      || (parsed.anchor.updatedAtMs as number) < 0
      || (parsed.anchor.updatedAtMs as number) >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(parsed.anchor.offsetWithinTimestamp)
      || (parsed.anchor.offsetWithinTimestamp as number) < 1
    ) return null;
    return {
      v: 1,
      kind: 'opencodeCandidateScan',
      searchMode: parsed.searchMode,
      searchTerm: parsed.searchTerm,
      scanned: parsed.scanned as number,
      anchor: {
        remoteSessionId: parsed.anchor.remoteSessionId,
        updatedAtMs: parsed.anchor.updatedAtMs as number,
        offsetWithinTimestamp: parsed.anchor.offsetWithinTimestamp as number,
      },
    };
  } catch {
    return null;
  }
}

function encodeOpenCodeCandidateCursor(value: OpenCodeCandidateCursor): string {
  return `${OPENCODE_CANDIDATE_CURSOR_PREFIX}${Buffer
    .from(JSON.stringify(value), 'utf8')
    .toString('base64url')}`;
}

function buildOpenCodeCandidate(
  raw: unknown,
  serverBaseUrl: string | null,
): OpenCodeExternalSessionCandidate | null {
  const parsed = parseOpenCodeSessionCandidate(raw);
  if (!parsed) {
    const remoteSessionId = readNonBlankOpaqueIdentifier(asRecord(raw)?.id);
    if (remoteSessionId) {
      throw new Error(
        `OpenCode session ${remoteSessionId} does not provide a stable updated timestamp for candidate paging.`,
      );
    }
    return null;
  }
  return {
    ...parsed,
    runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      providerSessionId: parsed.remoteSessionId,
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrl ? { serverBaseUrlExplicit: true } : {}),
    }),
  };
}

function validateOpenCodeCandidateSourceOrder(
  candidates: readonly OpenCodeExternalSessionCandidate[],
): void {
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1];
    const current = candidates[index];
    if (!previous || !current || previous.updatedAtMs < current.updatedAtMs) {
      throw new Error('OpenCode session listing did not preserve its descending update-time order.');
    }
  }
}

function createCursorAfterCandidate(params: Readonly<{
  query: OpenCodeCandidateQuery;
  candidates: readonly OpenCodeExternalSessionCandidate[];
  candidateIndex: number;
  scanned: number;
}>): OpenCodeCandidateAnchorCursor {
  const candidate = params.candidates[params.candidateIndex];
  if (!candidate) throw new Error('OpenCode candidate paging lost its continuation anchor.');
  let offsetWithinTimestamp = 0;
  for (let index = 0; index <= params.candidateIndex; index += 1) {
    if (params.candidates[index]?.updatedAtMs === candidate.updatedAtMs) {
      offsetWithinTimestamp += 1;
    }
  }
  return {
    v: 1,
    kind: 'opencodeCandidateScan',
    searchMode: params.query.searchMode,
    searchTerm: params.query.searchTerm,
    scanned: params.scanned,
    anchor: {
      remoteSessionId: candidate.remoteSessionId,
      updatedAtMs: candidate.updatedAtMs,
      offsetWithinTimestamp,
    },
  };
}

function sortCandidates(
  candidates: readonly OpenCodeExternalSessionCandidate[],
): OpenCodeExternalSessionCandidate[] {
  return [...candidates].sort(compareExternalSessionCandidatePrecedence);
}

/**
 * The same one-chunk-per-call walk over a source whose only continuation is the
 * opaque token V2's `/api/session` mints.
 *
 * Two vendor facts shape it, both from the pinned comparator
 * (`packages/protocol/src/groups/session.ts`, `packages/core/src/session.ts`):
 *
 * - the token resumes strictly *after* the page it came from, so this walk never
 *   stops mid-page. It requests exactly `limit` sessions, scans all of them, and
 *   continues from the page boundary — which is also why no anchor needs
 *   re-reading and no `offsetWithinTimestamp` exists here;
 * - V2 enumerates by `time.created`, not `time.updated`. The descending-update
 *   order V1 guarantees therefore does not hold and is not asserted; candidates
 *   are still sorted for the host by the shared precedence comparator, and the
 *   page boundary stays deterministic because the token, not a timestamp, decides
 *   it.
 *
 * A short page is the end of the corpus. A full page continues, so a full-text
 * search that found fewer matches than the page is reported as an incomplete
 * search with a continuation rather than as the end of the list.
 */
async function listOpenCodeSessionCandidatesFromSourceCursor(params: Readonly<{
  client: OpenCodeExternalSessionClient;
  query: OpenCodeCandidateQuery;
  limit: number;
  serverBaseUrl: string | null;
  serverSearch?: string;
  fullSearch: boolean;
  normalizedSearchTerm: string;
  cursor: OpenCodeCandidateSourceTokenCursor | null;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  candidates: OpenCodeExternalSessionCandidate[];
  nextCursor: string | null;
  scanned: number;
  searchIncomplete?: boolean;
}>> {
  const page = await params.client.sessionList({
    limit: params.limit,
    ...(params.serverSearch ? { search: params.serverSearch } : {}),
    ...(params.cursor
      ? { cursor: { kind: 'sourceToken' as const, token: params.cursor.sourceCursor } }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  const sourceCandidates: OpenCodeExternalSessionCandidate[] = [];
  for (const raw of page.items) {
    const candidate = buildOpenCodeCandidate(raw, params.serverBaseUrl);
    if (candidate) sourceCandidates.push(candidate);
  }

  const selected = params.fullSearch
    ? sourceCandidates.filter((candidate) => (
      candidate.remoteSessionId.toLowerCase().includes(params.normalizedSearchTerm)
      || candidate.title?.toLowerCase().includes(params.normalizedSearchTerm)
    ))
    : sourceCandidates;
  const scanned = (params.cursor?.scanned ?? 0) + sourceCandidates.length;
  const exhausted = page.items.length < params.limit || page.nextCursor === null;
  const nextCursor = exhausted || page.nextCursor === null
    ? null
    : encodeOpenCodeCandidateCursor({
      v: 2,
      kind: 'opencodeCandidateScan',
      searchMode: params.query.searchMode,
      searchTerm: params.query.searchTerm,
      scanned,
      sourceCursor: page.nextCursor,
    });
  const searchIncomplete = params.serverSearch !== undefined
    || (params.fullSearch && nextCursor !== null);
  return {
    candidates: sortCandidates(selected),
    nextCursor,
    scanned,
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}

/**
 * One bounded source chunk per public call: each invocation reads at most one
 * `sessionList` page. A full search whose chunk holds fewer matches than the
 * page while the source continues returns a deterministic partial page marked
 * `searchIncomplete` with a query-bound continuation; later calls resume the
 * walk without draining the remaining chunks in the first call.
 */
export async function listOpenCodeSessionCandidates(params: Readonly<{
  source: OpenCodeExternalSessionSource;
  dialect: OpenCodeServerDialect;
  cursor?: string;
  limit: number;
  maxBytes: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
}>): Promise<Readonly<{
  candidates: OpenCodeExternalSessionCandidate[];
  nextCursor: string | null;
  scanned: number;
  searchIncomplete?: boolean;
}>> {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
    throw new Error('OpenCode candidate page limit must be a positive safe integer.');
  }
  const limit = params.limit;
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
  const searchMode = params.searchMode === 'full' ? 'full' : 'fast';
  const query: OpenCodeCandidateQuery = { searchMode, searchTerm };
  const initialCursor = params.cursor ? readOpenCodeCandidateCursor(params.cursor) : null;
  // A continuation is only meaningful against the generation that minted it: a
  // timestamp anchor cannot be replayed to a V2 server and an opaque V2 token
  // means nothing to a V1 one. Refusing here keeps a source that changed
  // generation between calls from silently restarting at the newest session.
  const continuationMatchesDialect = initialCursor === null
    || (params.dialect === 'v2' ? initialCursor.v === 2 : initialCursor.v === 1);
  if (
    params.cursor
    && (
      !initialCursor
      || !continuationMatchesDialect
      || initialCursor.searchMode !== query.searchMode
      || initialCursor.searchTerm !== query.searchTerm
    )
  ) {
    throw new Error('OpenCode candidate cursor is invalid for this source query.');
  }
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    dialect: params.dialect,
    env: params.env,
    maxResponseBytes: params.maxBytes,
    ...(params.managedEndpointRead ? { managedEndpointRead: params.managedEndpointRead } : {}),
  });

  try {
    const serverBaseUrl = params.source.kind === 'opencodeServer'
      && typeof params.source.baseUrl === 'string'
      && params.source.baseUrl.trim().length > 0
      ? params.source.baseUrl.trim()
      : null;
    const serverSearch = searchTerm && searchMode === 'fast' ? searchTerm : undefined;
    const fullSearch = searchTerm.length > 0 && searchMode === 'full';
    const normalizedSearchTerm = searchTerm.toLowerCase();
    if (params.dialect === 'v2') {
      return await listOpenCodeSessionCandidatesFromSourceCursor({
        client,
        query,
        limit,
        serverBaseUrl,
        ...(serverSearch ? { serverSearch } : {}),
        fullSearch,
        normalizedSearchTerm,
        cursor: initialCursor?.v === 2 ? initialCursor : null,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    }
    const cursor = initialCursor?.v === 1 ? initialCursor : null;
    let scanned = cursor?.scanned ?? 0;
    const selected: OpenCodeExternalSessionCandidate[] = [];

    const requestedLimit = limit + 1 + (cursor?.anchor.offsetWithinTimestamp ?? 0);
    if (!Number.isSafeInteger(requestedLimit)) {
      throw new Error('OpenCode candidate continuation exceeds the supported source page range.');
    }
    const page = await client.sessionList({
      limit: requestedLimit,
      ...(serverSearch ? { search: serverSearch } : {}),
      ...(cursor
        ? { cursor: { kind: 'updatedAtMs' as const, updatedAtMs: cursor.anchor.updatedAtMs + 1 } }
        : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const sourceCandidates: OpenCodeExternalSessionCandidate[] = [];
    for (const raw of page.items) {
      const candidate = buildOpenCodeCandidate(raw, serverBaseUrl);
      if (candidate) sourceCandidates.push(candidate);
    }
    validateOpenCodeCandidateSourceOrder(sourceCandidates);

    const anchor = cursor?.anchor;
    const remainingStart = anchor?.offsetWithinTimestamp ?? 0;
    if (anchor) {
      const anchored = sourceCandidates[remainingStart - 1];
      if (
        !anchored
        || anchored.remoteSessionId !== anchor.remoteSessionId
        || anchored.updatedAtMs !== anchor.updatedAtMs
        || sourceCandidates.slice(0, remainingStart).some(
          (candidate) => candidate.updatedAtMs !== anchor.updatedAtMs,
        )
      ) {
        throw new Error('OpenCode candidate source changed while its continuation was in progress.');
      }
    }
    const remaining = sourceCandidates.slice(remainingStart);
    const processCount = Math.min(limit, remaining.length);
    if (processCount === 0) {
      return {
        candidates: sortCandidates(selected),
        nextCursor: null,
        scanned,
        ...(searchTerm && searchMode === 'fast' ? { searchIncomplete: true } : {}),
      };
    }

    let processedCount = 0;
    for (; processedCount < processCount; processedCount += 1) {
      const candidate = remaining[processedCount];
      if (!candidate) break;
      scanned += 1;
      if (
        !fullSearch
        || candidate.remoteSessionId.toLowerCase().includes(normalizedSearchTerm)
        || candidate.title?.toLowerCase().includes(normalizedSearchTerm)
      ) {
        selected.push(candidate);
      }
      if (fullSearch && selected.length === limit) {
        processedCount += 1;
        break;
      }
    }

    const lastProcessedIndex = remainingStart + processedCount - 1;
    const hasMore = lastProcessedIndex < sourceCandidates.length - 1;
    if (!fullSearch || selected.length === limit || !hasMore) {
      const nextCursor = hasMore && !serverSearch
        ? encodeOpenCodeCandidateCursor(createCursorAfterCandidate({
          query,
          candidates: sourceCandidates,
          candidateIndex: lastProcessedIndex,
          scanned,
        }))
        : null;
      return {
        candidates: sortCandidates(selected),
        nextCursor,
        scanned,
        ...(searchTerm && searchMode === 'fast' ? { searchIncomplete: true } : {}),
      };
    }
    return {
      candidates: sortCandidates(selected),
      nextCursor: encodeOpenCodeCandidateCursor(createCursorAfterCandidate({
        query,
        candidates: sourceCandidates,
        candidateIndex: lastProcessedIndex,
        scanned,
      })),
      scanned,
      searchIncomplete: true,
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}

export async function getOpenCodeExternalSessionVerifiedWorkingDirectory(params: Readonly<{
  source: OpenCodeExternalSessionSource;
  dialect: OpenCodeServerDialect;
  providerSessionId: string;
  maxBytes?: number;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
  baseUrlAuthority?: 'configured' | 'canonical';
}>): Promise<string | null> {
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    dialect: params.dialect,
    env: params.env,
    maxResponseBytes: params.maxBytes,
    ...(params.managedEndpointRead ? { managedEndpointRead: params.managedEndpointRead } : {}),
    ...(params.baseUrlAuthority
      ? { baseUrlAuthority: params.baseUrlAuthority }
      : {}),
  });
  try {
    const session = await client.sessionGet({
      sessionId: params.providerSessionId,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const directory =
      session && typeof session === 'object' && !Array.isArray(session)
      && typeof (session as Record<string, unknown>).directory === 'string'
        ? String((session as Record<string, unknown>).directory).trim()
        : '';
    return directory || null;
  } catch {
    return null;
  } finally {
    await client.dispose().catch(() => {});
  }
}

export async function getOpenCodeExternalSessionWorkingDirectory(params: Readonly<{
  source: OpenCodeExternalSessionSource;
  dialect: OpenCodeServerDialect;
  providerSessionId: string;
  maxBytes: number;
  managedEndpointRead?: AgentExternalSessionsManagedEndpointRead;
}>): Promise<string | null> {
  const verified = await getOpenCodeExternalSessionVerifiedWorkingDirectory(params);
  if (verified) return verified;

  if (params.source.kind === 'opencodeServer') {
    const fromSource = typeof params.source.directory === 'string' ? params.source.directory.trim() : '';
    if (fromSource.length > 0) return fromSource;
  }
  return null;
}
