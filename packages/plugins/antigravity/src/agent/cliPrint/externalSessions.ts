import type {
  AgentExternalSessionLinkData,
  AgentExternalSessionLinkDataValue,
  AgentExternalSessionsContribution,
  AgentExternalSessionsFailureCode,
  AgentExternalSessionsInvocation,
  AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionCandidate,
  AgentExternalSessionSource,
  AgentExternalSessionsListCandidatesResult,
  AgentExternalSessionsReadAfterTranscriptResult,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { compareExternalSessionCandidatePrecedence } from '@happier-dev/plugin-sdk/sessions/external';
import { canonicalizePath } from '@happier-dev/plugin-sdk/fs';

import {
  AntigravityCandidateSourceChangedError,
  isSafeAntigravityConversationId,
  pageAntigravityConversationCandidates,
  resolveAntigravityBrainDir,
  resolveAntigravityConversationCandidate,
  resolveAntigravityTranscriptFullPath,
} from './conversationStore.js';
import {
  pageAntigravityTranscriptLines,
  readAntigravityTranscriptLinesAfter,
} from './transcript/jsonl.js';
import {
  projectAntigravityTranscriptRecordGroupsWithCorrelation,
  projectAntigravityTranscriptRecordsToExternalItems,
} from './transcript/mapper.js';

const SOURCE_KIND = 'antigravityCliPrint';

type CandidateCursorV2 = Readonly<{
  v: 2;
  kind: 'antigravityCandidateIndexScan';
  brainDir: string;
  sourceGeneration: string;
  directoryEntryOffset: number;
}>;

type FullCandidateSearchCursorV1 = Readonly<{
  v: 1;
  kind: 'antigravityFullCandidateSearch';
  brainDir: string;
  sourceGeneration: string;
  searchTerm: string;
  after: Readonly<{
    remoteSessionId: string;
    updatedAtMs: number;
    sourceRevision: string;
  }>;
}>;

type AntigravityExternalReadAfterCursorV1 = Readonly<{
  v: 1;
  kind: 'antigravityExternalReadAfter';
  transcriptCursor: string;
  pendingToolCallIds: readonly string[];
}>;

type AntigravityExternalReadAfterOutcome =
  | Readonly<{ kind: 'already_current'; cursor: string; sourceRevision: string }>
  | Readonly<{
      kind: 'advanced';
      items: ReturnType<typeof projectAntigravityTranscriptRecordsToExternalItems>;
      nextCursor: string;
      hasMore: boolean;
      sourceRevision: string;
      skippedPositions?: readonly number[];
      sourceDiagnostics?: readonly Readonly<{
        code: 'malformed_source_utf8';
        count: number;
        positions: readonly number[];
      }>[];
    }>
  | Readonly<{ kind: 'gap_or_cursor_expired'; sourceRevision?: string }>
  | Readonly<{ kind: 'source_replaced'; sourceRevision: string }>
  | Readonly<{ kind: 'source_unavailable' }>
  | Readonly<{ kind: 'read_failed'; error: string }>;

function ok<T>(value: T): AgentExternalSessionsResult<T> {
  return { ok: true, value };
}

function failed(
  code: AgentExternalSessionsFailureCode,
  message?: string,
  retryable?: boolean,
): AgentExternalSessionsResult<never> {
  return {
    ok: false,
    code,
    ...(message ? { message } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function invocationFailure(
  invocation: AgentExternalSessionsInvocation,
): AgentExternalSessionsResult<never> | null {
  if (invocation.signal.aborted) return failed('cancelled');
  if (Date.now() >= invocation.deadlineAtMs) return failed('timeout', undefined, true);
  if (!Number.isFinite(invocation.maxSerializedBytes) || invocation.maxSerializedBytes < 1) {
    return failed('invalid_request');
  }
  return null;
}

function boundedResult<T>(
  invocation: AgentExternalSessionsInvocation,
  result: AgentExternalSessionsResult<T>,
): AgentExternalSessionsResult<T> {
  return serializedByteLength(result) <= invocation.maxSerializedBytes
    ? result
    : failed('invalid_request');
}

function readString(value: AgentExternalSessionLinkDataValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function encodeCandidateCursor(cursor: CandidateCursorV2 | FullCandidateSearchCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function encodeAntigravityExternalReadAfterCursor(
  cursor: AntigravityExternalReadAfterCursorV1,
): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeAntigravityExternalReadAfterCursor(
  raw: string,
): AntigravityExternalReadAfterCursorV1 | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const rawPendingToolCallIds = record.pendingToolCallIds;
    if (!Array.isArray(rawPendingToolCallIds)) return null;
    const pendingToolCallIds: string[] = [];
    for (const id of rawPendingToolCallIds) {
      if (typeof id !== 'string' || !id.trim()) return null;
      pendingToolCallIds.push(id);
    }
    if (
      record.v !== 1
      || record.kind !== 'antigravityExternalReadAfter'
      || typeof record.transcriptCursor !== 'string'
      || !record.transcriptCursor.trim()
    ) return null;
    return {
      v: 1,
      kind: 'antigravityExternalReadAfter',
      transcriptCursor: record.transcriptCursor,
      pendingToolCallIds,
    };
  } catch {
    return null;
  }
}

function decodeFullCandidateSearchCursor(raw: string | undefined): FullCandidateSearchCursorV1 | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const after = record.after;
    if (!after || typeof after !== 'object' || Array.isArray(after)) return null;
    const anchor = after as Record<string, unknown>;
    return record.v === 1
      && record.kind === 'antigravityFullCandidateSearch'
      && typeof record.brainDir === 'string'
      && record.brainDir.length > 0
      && typeof record.sourceGeneration === 'string'
      && record.sourceGeneration.length > 0
      && typeof record.searchTerm === 'string'
      && record.searchTerm.trim().length > 0
      && typeof anchor.remoteSessionId === 'string'
      && anchor.remoteSessionId.trim().length > 0
      && typeof anchor.updatedAtMs === 'number'
      && Number.isFinite(anchor.updatedAtMs)
      && typeof anchor.sourceRevision === 'string'
      && anchor.sourceRevision.trim().length > 0
      ? {
          v: 1,
          kind: 'antigravityFullCandidateSearch',
          brainDir: record.brainDir,
          sourceGeneration: record.sourceGeneration,
          searchTerm: record.searchTerm,
          after: {
            remoteSessionId: anchor.remoteSessionId,
            updatedAtMs: anchor.updatedAtMs,
            sourceRevision: anchor.sourceRevision,
          },
        }
      : null;
  } catch {
    return null;
  }
}

function decodeCandidateCursor(raw: string | undefined): CandidateCursorV2 | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.v === 2
      && record.kind === 'antigravityCandidateIndexScan'
      && typeof record.brainDir === 'string'
      && typeof record.sourceGeneration === 'string'
      && record.sourceGeneration.length > 0
      && Number.isSafeInteger(record.directoryEntryOffset)
      && (record.directoryEntryOffset as number) > 0
      ? {
          v: 2,
          kind: 'antigravityCandidateIndexScan',
          brainDir: record.brainDir,
          sourceGeneration: record.sourceGeneration,
          directoryEntryOffset: record.directoryEntryOffset as number,
        }
      : null;
  } catch {
    return null;
  }
}

async function validateSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: Readonly<Record<string, string | undefined>>;
}>): Promise<AgentExternalSessionsResult<Readonly<{
  brainDir: string;
  source: AgentExternalSessionSource;
}>>> {
  if (params.source.kind !== SOURCE_KIND) return failed('source_invalid', 'provider/source mismatch');
  const configuredBrainDir = await canonicalizePath(resolveAntigravityBrainDir(params.env));
  const requestedBrainDir = readString(params.source.brainDir);
  if (Object.hasOwn(params.source, 'brainDir') && !requestedBrainDir) {
    return failed('source_invalid', 'Antigravity brain directory must be a nonempty string.');
  }
  if (requestedBrainDir && await canonicalizePath(requestedBrainDir) !== configuredBrainDir) {
    return failed('source_invalid', 'Antigravity brain directory does not match the configured source.');
  }
  return ok({
    brainDir: configuredBrainDir,
    source: { kind: SOURCE_KIND, brainDir: configuredBrainDir },
  });
}

function validateResolvedSourceIdentity(
  source: AgentExternalSessionSource,
  remoteSessionId: string,
): AgentExternalSessionsResult<never> | null {
  const sourceConversationId = readString(source.conversationId);
  if (Object.hasOwn(source, 'conversationId') && !sourceConversationId) {
    return failed('source_invalid', 'Antigravity source conversation identity is invalid.');
  }
  if (sourceConversationId && sourceConversationId !== remoteSessionId) {
    return failed('source_invalid', 'Antigravity source conversation identity does not match the request.');
  }
  if (Object.hasOwn(source, 'sourceRevision') && !readString(source.sourceRevision)) {
    return failed('source_invalid', 'Antigravity source revision is invalid.');
  }
  return null;
}

function readLinkSourceRevision(linkData?: AgentExternalSessionLinkData): string | null {
  return readString(linkData?.sourceRevision);
}

function toResolvedSource(params: Readonly<{
  brainDir: string;
  conversationId: string;
  sourceRevision: string;
}>): AgentExternalSessionSource {
  return {
    kind: SOURCE_KIND,
    brainDir: params.brainDir,
    conversationId: params.conversationId,
    sourceRevision: params.sourceRevision,
  };
}

function toCandidate(candidate: Readonly<{
  conversationId: string;
  sourceRevision: string;
  updatedAtMs: number;
  title?: string;
}>): AgentExternalSessionCandidate {
  return {
    remoteSessionId: candidate.conversationId,
    updatedAtMs: candidate.updatedAtMs,
    ...(candidate.title ? { title: candidate.title } : {}),
    linkData: { sourceRevision: candidate.sourceRevision },
  };
}

function isFullCandidateSearchAnchor(
  candidate: AgentExternalSessionCandidate,
  anchor: FullCandidateSearchCursorV1['after'],
): boolean {
  return candidate.remoteSessionId === anchor.remoteSessionId
    && candidate.updatedAtMs === anchor.updatedAtMs
    && readLinkSourceRevision(candidate.linkData) === anchor.sourceRevision;
}

function fullCandidateSearchAnchorCandidate(
  anchor: FullCandidateSearchCursorV1['after'],
): AgentExternalSessionCandidate {
  return {
    remoteSessionId: anchor.remoteSessionId,
    updatedAtMs: anchor.updatedAtMs,
    linkData: { sourceRevision: anchor.sourceRevision },
  };
}

function encodeFullCandidateSearchCursor(params: Readonly<{
  brainDir: string;
  sourceGeneration: string;
  searchTerm: string;
  candidate: AgentExternalSessionCandidate;
}>): string | null {
  const sourceRevision = readLinkSourceRevision(params.candidate.linkData);
  if (!sourceRevision) return null;
  return encodeCandidateCursor({
    v: 1,
    kind: 'antigravityFullCandidateSearch',
    brainDir: params.brainDir,
    sourceGeneration: params.sourceGeneration,
    searchTerm: params.searchTerm,
    after: {
      remoteSessionId: params.candidate.remoteSessionId,
      updatedAtMs: params.candidate.updatedAtMs,
      sourceRevision,
    },
  });
}

/**
 * Search bypasses the host's complete candidate index. A full search therefore
 * exhausts the bounded native source and retains only the requested ordered
 * page plus one continuation row; it never becomes a second candidate index.
 */
async function listFullCandidateSearch(params: Readonly<{
  invocation: AgentExternalSessionsInvocation;
  brainDir: string;
  searchTerm: string;
  cursor: FullCandidateSearchCursorV1 | null;
  maxItems: number;
}>): Promise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>> {
  const limit = Math.trunc(params.maxItems);
  const after = params.cursor
    ? fullCandidateSearchAnchorCandidate(params.cursor.after)
    : null;
  let foundAfter = after === null;
  let sourceGeneration = params.cursor?.sourceGeneration ?? null;
  let afterDirectoryEntryOffset: number | null = null;
  const retained: AgentExternalSessionCandidate[] = [];

  while (true) {
    const stopped = invocationFailure(params.invocation);
    if (stopped) return stopped;
    const page = await pageAntigravityConversationCandidates({
      brainDir: params.brainDir,
      afterDirectoryEntryOffset,
      expectedSourceGeneration: sourceGeneration,
      maxItems: limit,
      signal: params.invocation.signal,
    });
    sourceGeneration ??= page.sourceGeneration;

    for (const nativeCandidate of page.candidates) {
      const candidate = toCandidate(nativeCandidate);
      if (
        !candidate.remoteSessionId.toLowerCase().includes(params.searchTerm)
        && candidate.title?.toLowerCase().includes(params.searchTerm) !== true
      ) {
        continue;
      }
      if (params.cursor) {
        if (isFullCandidateSearchAnchor(candidate, params.cursor.after)) {
          foundAfter = true;
          continue;
        }
        if (!after || compareExternalSessionCandidatePrecedence(candidate, after) <= 0) continue;
      }
      retained.push(candidate);
      retained.sort(compareExternalSessionCandidatePrecedence);
      if (retained.length > limit + 1) retained.pop();
    }

    if (page.nextDirectoryEntryOffset === null) break;
    afterDirectoryEntryOffset = page.nextDirectoryEntryOffset;
  }

  if (!foundAfter) {
    return failed('source_invalid', 'Antigravity full-search candidate cursor is stale or unavailable.', true);
  }
  const stopped = invocationFailure(params.invocation);
  if (stopped) return stopped;

  if (retained.length === 0) {
    return boundedResult(params.invocation, ok({ candidates: [], nextCursor: null }));
  }

  let candidates = retained.slice(0, limit);
  while (candidates.length > 0) {
    const hasMore = retained.length > candidates.length;
    const lastCandidate = candidates.at(-1);
    if (!lastCandidate) return failed('invalid_request');
    const nextCursor = hasMore && sourceGeneration
      ? encodeFullCandidateSearchCursor({
        brainDir: params.brainDir,
        sourceGeneration,
        searchTerm: params.searchTerm,
        candidate: lastCandidate,
      })
      : null;
    if (hasMore && !nextCursor) return failed('invalid_request');
    const result = ok({
      candidates,
      nextCursor,
    });
    if (serializedByteLength(result) <= params.invocation.maxSerializedBytes) return result;
    candidates = candidates.slice(0, -1);
  }

  return failed('invalid_request');
}

async function resolveIdentity(params: Readonly<{
  brainDir: string;
  remoteSessionId: string;
  expectedSourceRevision?: string | null;
}>): Promise<AgentExternalSessionsResult<Readonly<{
  source: AgentExternalSessionSource;
  remoteSessionId: string;
  linkData: AgentExternalSessionLinkData;
  transcriptPath: string;
}>>> {
  const candidate = await resolveAntigravityConversationCandidate({
    brainDir: params.brainDir,
    conversationId: params.remoteSessionId,
  });
  if (!candidate || (
    params.expectedSourceRevision
    && candidate.sourceRevision !== params.expectedSourceRevision
  )) {
    return failed('candidate_not_found', 'Antigravity conversation was not found or was replaced.');
  }
  return ok({
    source: toResolvedSource({
      brainDir: params.brainDir,
      conversationId: candidate.conversationId,
      sourceRevision: candidate.sourceRevision,
    }),
    remoteSessionId: candidate.conversationId,
    linkData: { sourceRevision: candidate.sourceRevision },
    transcriptPath: candidate.transcriptPath,
  });
}

async function resolveTranscriptReadTarget(params: Readonly<{
  brainDir: string;
  source: AgentExternalSessionSource;
  remoteSessionId: string;
}>): Promise<AgentExternalSessionsResult<Readonly<{
  transcriptPath: string;
  sourceRevision: string;
}>>> {
  const sourceRevision = readString(params.source.sourceRevision);
  if (sourceRevision) {
    if (!isSafeAntigravityConversationId(params.remoteSessionId)) {
      return failed('source_invalid', 'Antigravity conversation identity is invalid.');
    }
    return ok({
      transcriptPath: resolveAntigravityTranscriptFullPath(
        params.brainDir,
        params.remoteSessionId,
      ),
      sourceRevision,
    });
  }
  const resolved = await resolveIdentity({
    brainDir: params.brainDir,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved.ok) return resolved;
  const resolvedRevision = readLinkSourceRevision(resolved.value.linkData);
  if (!resolvedRevision) return failed('source_invalid', 'Antigravity source revision is invalid.');
  return ok({
    transcriptPath: resolved.value.transcriptPath,
    sourceRevision: resolvedRevision,
  });
}

export async function readAntigravityExternalTranscriptAfter(params: Readonly<{
  transcriptPath: string;
  conversationId: string;
  sourceRevision: string;
  cursor: string;
  maxItems: number;
  maxBytes: number;
}>): Promise<AntigravityExternalReadAfterOutcome> {
  const wrappedCursor = decodeAntigravityExternalReadAfterCursor(params.cursor);
  const outcome = await readAntigravityTranscriptLinesAfter({
    path: params.transcriptPath,
    conversationId: params.conversationId,
    sourceRevision: params.sourceRevision,
    cursor: wrappedCursor?.transcriptCursor ?? params.cursor,
    maxItems: params.maxItems,
    maxBytes: params.maxBytes,
    includeCorrelationLookback: !wrappedCursor,
  });
  if (outcome.kind === 'already_current') return { ...outcome, cursor: params.cursor };
  if (outcome.kind !== 'advanced') return outcome;
  const incomingPendingToolCallIds = wrappedCursor?.pendingToolCallIds
    ?? projectAntigravityTranscriptRecordGroupsWithCorrelation({
      conversationId: params.conversationId,
      records: outcome.correlationLookbackRecords ?? [],
    }).pendingToolCallIds;
  const projected = projectAntigravityTranscriptRecordGroupsWithCorrelation({
    conversationId: params.conversationId,
    records: outcome.records,
    pendingToolCallIds: incomingPendingToolCallIds,
  });
  const groups = projected.groups;
  const items = groups.flatMap((group) => group.items);
  const skippedPositions = groups
    .filter((group) => group.items.length === 0)
    .map((group) => group.startOffsetBytes);
  return {
    kind: 'advanced',
    items,
    nextCursor: encodeAntigravityExternalReadAfterCursor({
      v: 1,
      kind: 'antigravityExternalReadAfter',
      transcriptCursor: outcome.nextCursor,
      pendingToolCallIds: projected.pendingToolCallIds,
    }),
    hasMore: outcome.hasMore,
    sourceRevision: outcome.sourceRevision,
    ...(outcome.sourceDiagnostics === undefined
      ? {}
      : { sourceDiagnostics: outcome.sourceDiagnostics }),
    ...(skippedPositions.length > 0
      ? { skippedPositions }
      : {}),
  };
}

function mapReadAfterOutcome(
  outcome: AntigravityExternalReadAfterOutcome,
): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> {
  switch (outcome.kind) {
    case 'already_current':
      return ok({ outcome: 'already_current' });
    case 'advanced':
      return ok({
        outcome: 'advanced',
        items: outcome.items,
        nextCursor: outcome.nextCursor,
        boundary: outcome.items.at(-1)?.id ?? outcome.nextCursor,
        ...(outcome.sourceDiagnostics || outcome.skippedPositions
          ? {
              diagnostics: [
                ...(outcome.sourceDiagnostics ?? []),
                ...(outcome.skippedPositions
                  ? [{
                      code: 'unsupported_record_skipped',
                      count: outcome.skippedPositions.length,
                      positions: outcome.skippedPositions.slice(0, 200),
                    }]
                  : []),
              ],
            }
          : {}),
      });
    case 'gap_or_cursor_expired':
      return ok({ outcome: 'gap_or_cursor_expired' });
    case 'source_replaced':
      return ok({ outcome: 'source_replaced' });
    case 'source_unavailable':
      return ok({ outcome: 'source_unavailable' });
    case 'read_failed':
      return ok({ outcome: 'read_failed' });
  }
}

export function createAntigravityExternalSessionsContribution(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
}> = {}): AgentExternalSessionsContribution {
  const readEnv = () => params.env ?? process.env;

  return Object.freeze({
    async resolveSource(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      return boundedResult(request, ok({ source: validation.value.source }));
    },

    async listCandidates(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) return failed('invalid_request');
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const searchTerm = request.searchTerm?.trim().toLowerCase() ?? '';
      const fullSearch = searchTerm.length > 0 && request.searchMode === 'full';
      const fullSearchCursor = fullSearch && request.cursor
        ? decodeFullCandidateSearchCursor(request.cursor)
        : null;
      if (
        fullSearch
        && request.cursor
        && (
          !fullSearchCursor
          || fullSearchCursor.brainDir !== validation.value.brainDir
          || fullSearchCursor.searchTerm !== searchTerm
        )
      ) {
        return failed('invalid_request', 'Invalid Antigravity full-search candidate cursor.');
      }
      const decoded = fullSearch ? null : request.cursor ? decodeCandidateCursor(request.cursor) : null;
      if (!fullSearch && request.cursor && (!decoded || decoded.brainDir !== validation.value.brainDir)) {
        return failed('invalid_request', 'Invalid Antigravity candidate cursor.');
      }
      try {
        if (fullSearch) {
          return await listFullCandidateSearch({
            invocation: request,
            brainDir: validation.value.brainDir,
            searchTerm,
            cursor: fullSearchCursor,
            maxItems: request.maxItems,
          });
        }
        const page = await pageAntigravityConversationCandidates({
          brainDir: validation.value.brainDir,
          afterDirectoryEntryOffset: decoded?.directoryEntryOffset,
          expectedSourceGeneration: decoded?.sourceGeneration,
          maxItems: request.maxItems,
          signal: request.signal,
        });
        const filtered = searchTerm
          ? page.candidates.filter((candidate) => (
            candidate.conversationId.toLowerCase().includes(searchTerm)
            || candidate.title?.toLowerCase().includes(searchTerm)
          ))
          : page.candidates;
        const candidates: AgentExternalSessionCandidate[] = [];
        for (let index = 0; index < filtered.length; index += 1) {
          const candidate = filtered[index];
          if (!candidate) continue;
          const mapped = toCandidate(candidate);
          const hasMore = index < filtered.length - 1 || page.nextDirectoryEntryOffset !== null;
          const nextCursor = hasMore
            ? encodeCandidateCursor({
                v: 2,
                kind: 'antigravityCandidateIndexScan',
                brainDir: validation.value.brainDir,
                sourceGeneration: page.sourceGeneration ?? '',
                directoryEntryOffset: candidate.directoryEntryOffset,
              })
            : null;
          const proposed = ok({
            candidates: [...candidates, mapped],
            nextCursor,
            ...(searchTerm
              ? { searchIncomplete: true }
              : { preparation: { kind: 'building_candidate_index' as const, scanned: candidate.directoryEntryOffset } }),
          });
          if (serializedByteLength(proposed) > request.maxSerializedBytes) {
            if (candidates.length === 0) return failed('invalid_request');
            const lastAcceptedCandidate = filtered[index - 1];
            if (!lastAcceptedCandidate || !page.sourceGeneration) return failed('invalid_request');
            return ok({
              candidates,
              nextCursor: encodeCandidateCursor({
                v: 2,
                kind: 'antigravityCandidateIndexScan',
                brainDir: validation.value.brainDir,
                sourceGeneration: page.sourceGeneration,
                directoryEntryOffset: lastAcceptedCandidate.directoryEntryOffset,
              }),
              ...(searchTerm
                ? { searchIncomplete: true }
                : {
                  preparation: {
                    kind: 'building_candidate_index' as const,
                    scanned: lastAcceptedCandidate.directoryEntryOffset,
                  },
                }),
            });
          }
          candidates.push(mapped);
        }
        const result = ok({
          candidates,
          nextCursor: page.nextDirectoryEntryOffset !== null && page.sourceGeneration
            ? encodeCandidateCursor({
                v: 2,
                kind: 'antigravityCandidateIndexScan',
                brainDir: validation.value.brainDir,
                sourceGeneration: page.sourceGeneration,
                directoryEntryOffset: page.nextDirectoryEntryOffset,
              })
            : null,
          ...(searchTerm
            ? { searchIncomplete: true }
            : { preparation: { kind: 'building_candidate_index' as const, scanned: page.scanned } }),
        });
        return boundedResult(request, result);
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        if (error instanceof AntigravityCandidateSourceChangedError) {
          return boundedResult(request, failed('source_invalid', error.message, true));
        }
        return boundedResult(request, failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Antigravity candidate listing failed.',
          true,
        ));
      }
    },

    async resolveLinkIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const resolved = await resolveIdentity({
        brainDir: validation.value.brainDir,
        remoteSessionId: request.remoteSessionId,
        expectedSourceRevision: readLinkSourceRevision(request.linkData),
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const { transcriptPath: _transcriptPath, ...identity } = resolved.value;
      return boundedResult(request, ok(identity));
    },

    async resolveLinkedIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const sourceRevision = readLinkSourceRevision(request.linkData);
      if (!sourceRevision) return failed('invalid_request', 'Antigravity link identity requires sourceRevision.');
      const resolved = await resolveIdentity({
        brainDir: validation.value.brainDir,
        remoteSessionId: request.remoteSessionId,
        expectedSourceRevision: sourceRevision,
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const { transcriptPath: _transcriptPath, ...identity } = resolved.value;
      return boundedResult(request, ok(identity));
    },

    async pageTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (request.direction !== 'older') return failed('unsupported');
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) return failed('invalid_request');
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const resolved = await resolveTranscriptReadTarget({
        brainDir: validation.value.brainDir,
        source: request.source,
        remoteSessionId: request.remoteSessionId,
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const outcome = await pageAntigravityTranscriptLines({
        path: resolved.value.transcriptPath,
        conversationId: request.remoteSessionId,
        sourceRevision: resolved.value.sourceRevision,
        cursor: request.cursor,
        maxItems: request.maxItems,
        maxBytes: request.maxSerializedBytes,
      });
      const after = invocationFailure(request);
      if (after) return after;
      if (outcome.kind === 'source_unavailable') return failed('unavailable', undefined, true);
      if (outcome.kind === 'read_failed') return boundedResult(request, failed('agent_error', outcome.error));
      if (outcome.kind === 'source_replaced') {
        return boundedResult(request, ok({ items: [], nextCursor: null, hasMore: false, truncated: true }));
      }
      if (outcome.kind === 'gap_or_cursor_expired') {
        return boundedResult(request, ok({
          items: [],
          nextCursor: null,
          tailCursor: outcome.tailCursor,
          hasMore: false,
          truncated: true,
        }));
      }
      const incomingPendingToolCallIds = projectAntigravityTranscriptRecordGroupsWithCorrelation({
        conversationId: request.remoteSessionId,
        records: outcome.correlationLookbackRecords,
      }).pendingToolCallIds;
      const projected = projectAntigravityTranscriptRecordGroupsWithCorrelation({
        conversationId: request.remoteSessionId,
        records: outcome.records,
        pendingToolCallIds: incomingPendingToolCallIds,
      });
      const groups = projected.groups;
      const items = groups.flatMap((group) => group.items);
      if (items.length > request.maxItems) return failed('invalid_request');
      const tailPendingToolCallIds = projectAntigravityTranscriptRecordGroupsWithCorrelation({
        conversationId: request.remoteSessionId,
        records: outcome.tailCorrelationLookbackRecords,
      }).pendingToolCallIds;
      return boundedResult(request, ok({
        items,
        nextCursor: outcome.nextCursor,
        tailCursor: encodeAntigravityExternalReadAfterCursor({
          v: 1,
          kind: 'antigravityExternalReadAfter',
          transcriptCursor: outcome.tailCursor,
          pendingToolCallIds: tailPendingToolCallIds,
        }),
        hasMore: outcome.hasMore,
      }));
    },

    async readAfterTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) return failed('invalid_request');
      const identityMismatch = validateResolvedSourceIdentity(request.source, request.remoteSessionId);
      if (identityMismatch) return boundedResult(request, identityMismatch);
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const resolved = await resolveTranscriptReadTarget({
        brainDir: validation.value.brainDir,
        source: request.source,
        remoteSessionId: request.remoteSessionId,
      });
      if (!resolved.ok) return boundedResult(request, resolved);
      const outcome = await readAntigravityExternalTranscriptAfter({
        transcriptPath: resolved.value.transcriptPath,
        conversationId: request.remoteSessionId,
        sourceRevision: resolved.value.sourceRevision,
        cursor: request.cursor,
        maxItems: request.maxItems,
        maxBytes: request.maxSerializedBytes,
      });
      const after = invocationFailure(request);
      if (after) return after;
      if (outcome.kind === 'advanced' && outcome.items.length > request.maxItems) {
        return failed('invalid_request');
      }
      return boundedResult(request, mapReadAfterOutcome(outcome));
    },
  });
}

// Annotated with the factory's own declared return type: the contribution surface now reaches
// `ManagedServiceSpec` transitively, so an inferred type would make declaration emit name it
// through a deep relative path it cannot portably reference.
export const antigravityExternalSessionsContribution: AgentExternalSessionsContribution =
  createAntigravityExternalSessionsContribution();
