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
import {
  compareExternalSessionCandidatePrecedence,
  createAgentExternalSessionsProducerOverflowFailure,
  getAgentExternalSessionsInvocationFailure,
  isAgentExternalSessionsResultWithinByteBudget,
} from '@happier-dev/plugin-sdk/sessions/external';
import { canonicalizePath } from '@happier-dev/plugin-sdk/fs';

import {
  AntigravityCandidateSourceChangedError,
  authorizeAntigravityConversationTranscriptFile,
  isSafeAntigravityConversationId,
  pageAntigravityConversationCandidates,
  resolveAntigravityBrainDir,
  resolveAntigravityConversationCandidate,
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

type FullCandidateSearchCursorV2 = Readonly<{
  v: 2;
  kind: 'antigravityFullCandidateSearch';
  brainDir: string;
  sourceGeneration: string;
  searchTerm: string;
  /** Directory-scan position the next bounded chunk resumes at. */
  directoryEntryOffset: number;
  /**
   * Last candidate this search served. Matches ordering at or before it were
   * already delivered by earlier chunks; a new one means the ordering moved
   * under the cursor. Absent until a first chunk serves a match.
   */
  after?: Readonly<{
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
  /**
   * Public items of the window at `transcriptCursor` already delivered. One
   * native record projects to assistant text PLUS one item per tool call, so a
   * small item budget cannot always be met by advancing whole records. The
   * native budgets that produced the window are pinned alongside it so a caller
   * page-size change cannot reslice a different window at the same position.
   */
  itemStart?: number;
  nativeMaxItems?: number;
  nativeMaxBytes?: number;
}>;

/**
 * A transcript page is budgeted in PUBLIC items, but the source is budgeted in
 * NATIVE records, and one valid record projects to several items. Without a
 * position inside the projected window, a record wider than the item budget is
 * unreadable at every retry. This cursor replays the same native window and
 * carries the exclusive end of the slice still owed to the caller.
 */
type AntigravityExternalPageCursorV1 = Readonly<{
  v: 1;
  kind: 'antigravityExternalPage';
  /** Native backward cursor for the window to replay; null replays the newest window. */
  nativeCursor: string | null;
  /**
   * Native record and byte budgets this window was read with. `itemEnd` indexes
   * that window's projection, so replaying under a caller-chosen budget would
   * slice a different window and emit different history at the same position.
   */
  nativeMaxItems: number;
  nativeMaxBytes: number;
  /** Exclusive end index into that window's projected items; absent means all of them. */
  itemEnd?: number;
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
      nonTranscriptPositions?: readonly number[];
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

function boundedResult<T>(
  invocation: AgentExternalSessionsInvocation,
  result: AgentExternalSessionsResult<T>,
): AgentExternalSessionsResult<T> {
  return isAgentExternalSessionsResultWithinByteBudget(result, invocation.maxSerializedBytes)
    ? result
    : createAgentExternalSessionsProducerOverflowFailure(
      'Antigravity result cannot fit the valid serialized-byte bound.',
    );
}

function readString(value: AgentExternalSessionLinkDataValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function encodeCandidateCursor(
  cursor: CandidateCursorV2 | FullCandidateSearchCursorV2,
): string {
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
    const rawItemStart = record.itemStart;
    if (
      rawItemStart !== undefined
      && (!Number.isSafeInteger(rawItemStart) || (rawItemStart as number) < 1)
    ) return null;
    const rawNativeMaxItems = record.nativeMaxItems;
    const rawNativeMaxBytes = record.nativeMaxBytes;
    if (
      (rawItemStart === undefined) !== (rawNativeMaxItems === undefined)
      || (rawItemStart === undefined) !== (rawNativeMaxBytes === undefined)
    ) return null;
    if (
      rawItemStart !== undefined
      && (
        !Number.isSafeInteger(rawNativeMaxItems) || (rawNativeMaxItems as number) < 1
        || !Number.isSafeInteger(rawNativeMaxBytes) || (rawNativeMaxBytes as number) < 1
      )
    ) return null;
    return {
      v: 1,
      kind: 'antigravityExternalReadAfter',
      transcriptCursor: record.transcriptCursor,
      pendingToolCallIds,
      ...(rawItemStart === undefined
        ? {}
        : {
          itemStart: rawItemStart as number,
          nativeMaxItems: rawNativeMaxItems as number,
          nativeMaxBytes: rawNativeMaxBytes as number,
        }),
    };
  } catch {
    return null;
  }
}

function encodeAntigravityExternalPageCursor(cursor: AntigravityExternalPageCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeAntigravityExternalPageCursor(
  raw: string,
): AntigravityExternalPageCursorV1 | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== 'antigravityExternalPage') return null;
    const nativeCursor = record.nativeCursor;
    if (nativeCursor !== null && (typeof nativeCursor !== 'string' || !nativeCursor.trim())) {
      return null;
    }
    const itemEnd = record.itemEnd;
    if (itemEnd !== undefined && (!Number.isSafeInteger(itemEnd) || (itemEnd as number) < 1)) {
      return null;
    }
    const nativeMaxItems = record.nativeMaxItems;
    const nativeMaxBytes = record.nativeMaxBytes;
    if (
      !Number.isSafeInteger(nativeMaxItems) || (nativeMaxItems as number) < 1
      || !Number.isSafeInteger(nativeMaxBytes) || (nativeMaxBytes as number) < 1
    ) return null;
    return {
      v: 1,
      kind: 'antigravityExternalPage',
      nativeCursor,
      nativeMaxItems: nativeMaxItems as number,
      nativeMaxBytes: nativeMaxBytes as number,
      ...(itemEnd === undefined ? {} : { itemEnd: itemEnd as number }),
    };
  } catch {
    return null;
  }
}

function decodeFullCandidateSearchCursor(raw: string | undefined): FullCandidateSearchCursorV2 | null {
  if (!raw?.trim()) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.v !== 2
      || record.kind !== 'antigravityFullCandidateSearch'
      || typeof record.brainDir !== 'string'
      || record.brainDir.length === 0
      || typeof record.sourceGeneration !== 'string'
      || record.sourceGeneration.length === 0
      || typeof record.searchTerm !== 'string'
      || record.searchTerm.trim().length === 0
      || !Number.isSafeInteger(record.directoryEntryOffset)
      || (record.directoryEntryOffset as number) < 1
    ) return null;
    let after: FullCandidateSearchCursorV2['after'];
    if (record.after !== undefined) {
      if (!record.after || typeof record.after !== 'object' || Array.isArray(record.after)) return null;
      const anchor = record.after as Record<string, unknown>;
      if (
        typeof anchor.remoteSessionId !== 'string'
        || anchor.remoteSessionId.trim().length === 0
        || typeof anchor.updatedAtMs !== 'number'
        || !Number.isFinite(anchor.updatedAtMs)
        || typeof anchor.sourceRevision !== 'string'
        || anchor.sourceRevision.trim().length === 0
      ) return null;
      after = {
        remoteSessionId: anchor.remoteSessionId,
        updatedAtMs: anchor.updatedAtMs,
        sourceRevision: anchor.sourceRevision,
      };
    }
    return {
      v: 2,
      kind: 'antigravityFullCandidateSearch',
      brainDir: record.brainDir,
      sourceGeneration: record.sourceGeneration,
      searchTerm: record.searchTerm,
      directoryEntryOffset: record.directoryEntryOffset as number,
      ...(after ? { after } : {}),
    };
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
  const requestedBrainDir = readString(params.source.brainDir);
  if (Object.hasOwn(params.source, 'brainDir') && !requestedBrainDir) {
    return failed('source_invalid', 'Antigravity brain directory must be a nonempty string.');
  }
  // Canonicalization only. Whether a requested brain directory is one the
  // machine environment or the account's settings authorized is decided once,
  // by the host admission boundary, for every Agent.
  const brainDir = requestedBrainDir
    ? await canonicalizePath(requestedBrainDir)
    : await canonicalizePath(resolveAntigravityBrainDir(params.env));
  return ok({
    brainDir,
    source: { kind: SOURCE_KIND, brainDir },
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

function fullCandidateSearchAnchorCandidate(
  anchor: NonNullable<FullCandidateSearchCursorV2['after']>,
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
  directoryEntryOffset: number;
  after?: AgentExternalSessionCandidate;
}>): string | null {
  let after: FullCandidateSearchCursorV2['after'];
  if (params.after) {
    const sourceRevision = readLinkSourceRevision(params.after.linkData);
    if (!sourceRevision) return null;
    after = {
      remoteSessionId: params.after.remoteSessionId,
      updatedAtMs: params.after.updatedAtMs,
      sourceRevision,
    };
  }
  return encodeCandidateCursor({
    v: 2,
    kind: 'antigravityFullCandidateSearch',
    brainDir: params.brainDir,
    sourceGeneration: params.sourceGeneration,
    searchTerm: params.searchTerm,
    directoryEntryOffset: params.directoryEntryOffset,
    ...(after ? { after } : {}),
  });
}

/**
 * Search bypasses the host's complete candidate index. Each invocation reads
 * one bounded directory chunk and returns the matches it held: reaching the
 * end of the source completes the search, and anything earlier returns a
 * deterministic partial page marked `searchIncomplete` with a query-bound
 * continuation that resumes at the chunk boundary on a later call. It never
 * becomes a second candidate index.
 */
async function listFullCandidateSearch(params: Readonly<{
  invocation: AgentExternalSessionsInvocation;
  brainDir: string;
  searchTerm: string;
  cursor: FullCandidateSearchCursorV2 | null;
  maxItems: number;
}>): Promise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>> {
  const limit = Math.trunc(params.maxItems);
  const after = params.cursor?.after
    ? fullCandidateSearchAnchorCandidate(params.cursor.after)
    : null;
  const page = await pageAntigravityConversationCandidates({
    brainDir: params.brainDir,
    afterDirectoryEntryOffset: params.cursor?.directoryEntryOffset,
    expectedSourceGeneration: params.cursor?.sourceGeneration ?? null,
    maxItems: limit,
    signal: params.invocation.signal,
  });

  const retained: AgentExternalSessionCandidate[] = [];
  for (const nativeCandidate of page.candidates) {
    const candidate = toCandidate(nativeCandidate);
    if (
      !candidate.remoteSessionId.toLowerCase().includes(params.searchTerm)
      && candidate.title?.toLowerCase().includes(params.searchTerm) !== true
    ) {
      continue;
    }
    // One bounded chunk per invocation: this chunk's scan position is past
    // every match earlier chunks served, so a match ordering at or before the
    // served anchor was never delivered — answering this chunk would drop it
    // or repeat the prefix it moved into.
    if (after && compareExternalSessionCandidatePrecedence(candidate, after) <= 0) {
      return failed(
        'source_invalid',
        'Antigravity full-search candidate ordering changed under its cursor.',
        true,
      );
    }
    retained.push(candidate);
  }
  retained.sort(compareExternalSessionCandidatePrecedence);

  const stopped = getAgentExternalSessionsInvocationFailure(params.invocation);
  if (stopped) return stopped;

  const exhausted = page.nextDirectoryEntryOffset === null;
  let nextCursor: string | null = null;
  if (!exhausted && page.nextDirectoryEntryOffset !== null) {
    const sourceGeneration = page.sourceGeneration;
    if (!sourceGeneration) {
      return failed('agent_error', 'Antigravity candidate continuation cannot be represented.', false);
    }
    // The anchor moves to the newest match this chunk served; a chunk without
    // a match carries the previous anchor, or none until a first match serves.
    const servedAnchor = retained.at(-1) ?? after ?? undefined;
    nextCursor = encodeFullCandidateSearchCursor({
      brainDir: params.brainDir,
      sourceGeneration,
      searchTerm: params.searchTerm,
      directoryEntryOffset: page.nextDirectoryEntryOffset,
      ...(servedAnchor ? { after: servedAnchor } : {}),
    });
    if (!nextCursor) {
      return failed('agent_error', 'Antigravity candidate continuation cannot be represented.', false);
    }
  }

  return boundedResult(params.invocation, ok({
    candidates: retained,
    nextCursor,
    ...(exhausted ? {} : { searchIncomplete: true }),
  }));
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
    const authorization = await authorizeAntigravityConversationTranscriptFile({
      brainDir: params.brainDir,
      conversationId: params.remoteSessionId,
    });
    if (authorization.status !== 'authorized') {
      return authorization.status === 'unavailable'
        ? failed('unavailable', 'Antigravity conversation is unavailable.', true)
        : failed('candidate_not_found', 'Antigravity conversation was not found or was replaced.');
    }
    return ok({
      transcriptPath: authorization.transcriptPath,
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
  const nativeMaxItems = wrappedCursor?.nativeMaxItems ?? Math.trunc(params.maxItems);
  const nativeMaxBytes = wrappedCursor?.nativeMaxBytes ?? params.maxBytes;
  const outcome = await readAntigravityTranscriptLinesAfter({
    path: params.transcriptPath,
    conversationId: params.conversationId,
    sourceRevision: params.sourceRevision,
    cursor: wrappedCursor?.transcriptCursor ?? params.cursor,
    maxItems: nativeMaxItems,
    maxBytes: nativeMaxBytes,
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
  const windowItems = groups.flatMap((group) => group.items);
  // One native record projects to assistant text PLUS one item per tool call, so
  // whole-record advancement cannot honor a smaller item budget. Resume inside
  // the projected window instead of refusing the record forever.
  const itemStart = wrappedCursor?.itemStart ?? 0;
  if (itemStart > windowItems.length) return { kind: 'gap_or_cursor_expired' };
  const itemEnd = Math.min(windowItems.length, itemStart + Math.trunc(params.maxItems));
  const items = windowItems.slice(itemStart, itemEnd);
  const windowDrained = itemEnd >= windowItems.length;
  const emptyGroups = groups.filter((group) => group.items.length === 0);
  // The host counts every skip code except `non_transcript_record_skipped` as a
  // REQUIRED item failure, so a checkpoint this build deliberately omits must
  // not be reported as history it could not read. Reported once, when this
  // window is retired, so replaying it cannot inflate the counts.
  const skippedPositions = windowDrained
    ? emptyGroups.filter((group) => group.unsupported).map((group) => group.startOffsetBytes)
    : [];
  const nonTranscriptPositions = windowDrained
    ? emptyGroups.filter((group) => !group.unsupported).map((group) => group.startOffsetBytes)
    : [];
  return {
    kind: 'advanced',
    items,
    nextCursor: windowDrained
      ? encodeAntigravityExternalReadAfterCursor({
        v: 1,
        kind: 'antigravityExternalReadAfter',
        transcriptCursor: outcome.nextCursor,
        pendingToolCallIds: projected.pendingToolCallIds,
      })
      : encodeAntigravityExternalReadAfterCursor({
        v: 1,
        kind: 'antigravityExternalReadAfter',
        transcriptCursor: wrappedCursor?.transcriptCursor ?? params.cursor,
        pendingToolCallIds: incomingPendingToolCallIds,
        itemStart: itemEnd,
        nativeMaxItems,
        nativeMaxBytes,
      }),
    hasMore: windowDrained ? outcome.hasMore : true,
    sourceRevision: outcome.sourceRevision,
    ...(outcome.sourceDiagnostics === undefined
      ? {}
      : { sourceDiagnostics: outcome.sourceDiagnostics }),
    ...(skippedPositions.length > 0
      ? { skippedPositions }
      : {}),
    ...(nonTranscriptPositions.length > 0
      ? { nonTranscriptPositions }
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
        hasMore: outcome.hasMore,
        ...(outcome.sourceDiagnostics
          || outcome.skippedPositions
          || outcome.nonTranscriptPositions
          ? {
              diagnostics: [
                ...(outcome.sourceDiagnostics ?? []).map((diagnostic) => ({
                  ...diagnostic,
                  severity: 'required' as const,
                })),
                ...(outcome.nonTranscriptPositions
                  ? [{
                      code: 'non_transcript_record_skipped',
                      severity: 'benign' as const,
                      count: outcome.nonTranscriptPositions.length,
                      positions: outcome.nonTranscriptPositions.slice(0, 200),
                    }]
                  : []),
                ...(outcome.skippedPositions
                  ? [{
                      code: 'unsupported_record_skipped',
                      severity: 'required' as const,
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
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      return boundedResult(request, ok({ source: validation.value.source }));
    },

    async listCandidates(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
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
          if (!isAgentExternalSessionsResultWithinByteBudget(
            proposed,
            request.maxSerializedBytes,
          )) {
            if (candidates.length === 0) {
              return createAgentExternalSessionsProducerOverflowFailure(
                'Antigravity candidate result cannot fit the valid serialized-byte bound.',
              );
            }
            const lastAcceptedCandidate = filtered[index - 1];
            if (!lastAcceptedCandidate || !page.sourceGeneration) {
              return failed('agent_error', 'Antigravity candidate continuation cannot be represented.', false);
            }
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
        const after = getAgentExternalSessionsInvocationFailure(request);
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
      const stopped = getAgentExternalSessionsInvocationFailure(request);
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
      const stopped = getAgentExternalSessionsInvocationFailure(request);
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
      const stopped = getAgentExternalSessionsInvocationFailure(request);
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
      const pageCursor = request.cursor
        ? decodeAntigravityExternalPageCursor(request.cursor)
        : null;
      if (request.cursor && !pageCursor) {
        return failed('invalid_request', 'Invalid Antigravity transcript page cursor.');
      }
      const nativeMaxItems = pageCursor?.nativeMaxItems ?? Math.trunc(request.maxItems);
      const nativeMaxBytes = pageCursor?.nativeMaxBytes ?? request.maxSerializedBytes;
      const outcome = await pageAntigravityTranscriptLines({
        path: resolved.value.transcriptPath,
        conversationId: request.remoteSessionId,
        sourceRevision: resolved.value.sourceRevision,
        ...(pageCursor?.nativeCursor ? { cursor: pageCursor.nativeCursor } : {}),
        maxItems: nativeMaxItems,
        maxBytes: nativeMaxBytes,
      });
      const after = getAgentExternalSessionsInvocationFailure(request);
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
      // A transcript page carries no diagnostics channel, so a record this build
      // cannot read can only be reported by declaring the page INCOMPLETE.
      // Records arrive oldest-first inside a backward page, so everything older
      // than the newest unreadable record is unreachable: publishing it as an
      // ordinary success would finalize a history with a silent hole and hand
      // back a cursor that walks straight past it.
      const lastUnsupportedIndex = groups.reduce(
        (found, group, index) => (group.unsupported ? index : found),
        -1,
      );
      const readableGroups = lastUnsupportedIndex < 0
        ? groups
        : groups.slice(lastUnsupportedIndex + 1);
      const windowItems = readableGroups.flatMap((group) => group.items);
      // The cursor replays this window; a smaller projection than it recorded
      // means the source moved under it, and slicing it anyway would silently
      // emit different history at the same position.
      if (pageCursor?.itemEnd !== undefined && pageCursor.itemEnd > windowItems.length) {
        return boundedResult(request, ok({
          items: [],
          nextCursor: null,
          hasMore: false,
          truncated: true,
        }));
      }
      const itemEnd = pageCursor?.itemEnd ?? windowItems.length;
      const itemStart = Math.max(0, itemEnd - request.maxItems);
      const items = windowItems.slice(itemStart, itemEnd);
      const windowDrained = itemStart === 0;
      const tailPendingToolCallIds = projectAntigravityTranscriptRecordGroupsWithCorrelation({
        conversationId: request.remoteSessionId,
        records: outcome.tailCorrelationLookbackRecords,
      }).pendingToolCallIds;
      // Older items of this window are unreachable past an unreadable record,
      // but the readable ones newer than it are still owed to the caller, so the
      // page only becomes incomplete once this window is drained.
      const truncated = lastUnsupportedIndex >= 0 && windowDrained;
      const nextCursor = !windowDrained
        ? encodeAntigravityExternalPageCursor({
          v: 1,
          kind: 'antigravityExternalPage',
          nativeCursor: pageCursor?.nativeCursor ?? null,
          nativeMaxItems,
          nativeMaxBytes,
          itemEnd: itemStart,
        })
        : truncated || outcome.nextCursor === null
          ? null
          : encodeAntigravityExternalPageCursor({
            v: 1,
            kind: 'antigravityExternalPage',
            nativeCursor: outcome.nextCursor,
            nativeMaxItems,
            nativeMaxBytes,
          });
      return boundedResult(request, ok({
        items,
        nextCursor,
        tailCursor: encodeAntigravityExternalReadAfterCursor({
          v: 1,
          kind: 'antigravityExternalReadAfter',
          transcriptCursor: outcome.tailCursor,
          pendingToolCallIds: tailPendingToolCallIds,
        }),
        hasMore: nextCursor !== null,
        ...(truncated ? { truncated: true } : {}),
      }));
    },

    async readAfterTranscript(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
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
      if (!resolved.ok) {
        // The shared physical authorizer classifies an absent physical file
        // separately from an unauthorized alias. Read-after exposes the former
        // as its successful source discontinuity; an alias remains an identity
        // failure. Page/identity calls keep their own method contract at the
        // same authorizer.
        return boundedResult(
          request,
          resolved.code === 'unavailable'
            ? ok({ outcome: 'source_unavailable' as const })
            : resolved,
        );
      }
      const outcome = await readAntigravityExternalTranscriptAfter({
        transcriptPath: resolved.value.transcriptPath,
        conversationId: request.remoteSessionId,
        sourceRevision: resolved.value.sourceRevision,
        cursor: request.cursor,
        maxItems: request.maxItems,
        maxBytes: request.maxSerializedBytes,
      });
      const after = getAgentExternalSessionsInvocationFailure(request);
      if (after) return after;
      return boundedResult(request, mapReadAfterOutcome(outcome));
    },
  });
}

// Annotated with the factory's own declared return type: the contribution surface now reaches
// `ManagedServiceSpec` transitively, so an inferred type would make declaration emit name it
// through a deep relative path it cannot portably reference.
export const antigravityExternalSessionsContribution: AgentExternalSessionsContribution =
  createAntigravityExternalSessionsContribution();
