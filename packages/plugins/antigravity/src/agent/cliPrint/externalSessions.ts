import { isPluginError } from '@happier-dev/plugin-sdk';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type {
  AgentExternalSessionLinkData,
  AgentExternalSessionLinkDataValue,
  AgentExternalSessionsContribution,
  AgentExternalSessionsFailureCode,
  AgentExternalSessionsInvocation,
  AgentExternalSessionsListCandidatesRequest,
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
  ExternalSessionActivityPageBudgetError,
  pageExternalSessionCandidatesByActivity,
  parseExternalSessionActivityPosition,
  type ExternalSessionActivityPosition,
  getAgentExternalSessionsInvocationFailure,
  isAgentExternalSessionsResultWithinByteBudget,
} from '@happier-dev/plugin-sdk/sessions/external';
import { canonicalizePath } from '@happier-dev/plugin-sdk/fs';
import {
  createExternalSessionContentSearchControl,
  discoverAgentAccountingJsonlSource,
  ExternalSessionContentSearchYield,
  readJsonlFileForwardLines,
  searchExternalSessionContent,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import {
  AntigravityCandidateSourceChangedError,
  authorizeAntigravityConversationTranscriptFile,
  isSafeAntigravityConversationId,
  listAntigravityConversationActivity,
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

/** Unsearched Browse continuation: the last row served, in activity order. */
type ActivityCandidateCursorV3 = Readonly<{
  v: 3;
  kind: 'antigravityCandidateActivity';
  brainDir: string;
  after: ExternalSessionActivityPosition;
}>;

type FullCandidateSearchCursorV2 = Readonly<{
  v: 2;
  kind: 'antigravityFullCandidateSearch';
  brainDir: string;
  sourceGeneration: string;
  searchTerm: string;
  searchTarget?: 'content';
  /** Directory-scan position the next bounded chunk resumes at. */
  directoryEntryOffset: number;
  contentProgress?: AntigravityContentSearchProgress;
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

type AntigravityContentSearchProgress = Readonly<{
  conversationId: string;
  sourceIdentity: string;
  offsetBytes: number;
  count: number;
  partial: boolean;
  pendingToolCallIds: readonly string[];
  match?: Readonly<{
    startOffsetBytes: number;
    endOffsetBytes: number;
    itemIndex: number;
    messageIndex: number;
  }>;
}>;

function parseContentSearchProgress(value: unknown): AntigravityContentSearchProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.conversationId !== 'string' || !isSafeAntigravityConversationId(record.conversationId)
    || typeof record.sourceIdentity !== 'string' || !record.sourceIdentity
    || !Number.isSafeInteger(record.offsetBytes) || (record.offsetBytes as number) < 0
    || !Number.isSafeInteger(record.count) || (record.count as number) < 0
    || typeof record.partial !== 'boolean' || !Array.isArray(record.pendingToolCallIds)
    || record.pendingToolCallIds.some((id) => typeof id !== 'string' || !id.trim())) return null;
  let match: AntigravityContentSearchProgress['match'];
  if (record.match !== undefined) {
    if (!record.match || typeof record.match !== 'object' || Array.isArray(record.match)) return null;
    const row = record.match as Record<string, unknown>;
    for (const key of ['startOffsetBytes', 'endOffsetBytes', 'itemIndex', 'messageIndex'] as const) {
      if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) return null;
    }
    if ((row.endOffsetBytes as number) < (row.startOffsetBytes as number)) return null;
    match = { startOffsetBytes: row.startOffsetBytes as number, endOffsetBytes: row.endOffsetBytes as number,
      itemIndex: row.itemIndex as number, messageIndex: row.messageIndex as number };
  }
  return { conversationId: record.conversationId, sourceIdentity: record.sourceIdentity,
    offsetBytes: record.offsetBytes as number, count: record.count as number, partial: record.partial,
    pendingToolCallIds: record.pendingToolCallIds as string[], ...(match ? { match } : {}) };
}

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
  | Readonly<{ kind: 'read_failed'; error: string; code?: 'JSONL_RECORD_TOO_LARGE' }>;

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
  cursor: CandidateCursorV2 | FullCandidateSearchCursorV2 | ActivityCandidateCursorV3,
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
      || (record.searchTarget === 'content' ? record.searchTerm.length === 0 : record.searchTerm.trim().length === 0)
      || !Number.isSafeInteger(record.directoryEntryOffset)
      || (record.directoryEntryOffset as number) < (record.searchTarget === 'content' ? 0 : 1)
      || (record.searchTarget !== undefined && record.searchTarget !== 'content')
    ) return null;
    let after: FullCandidateSearchCursorV2['after'];
    const contentProgress = record.contentProgress === undefined ? undefined : parseContentSearchProgress(record.contentProgress);
    if (record.contentProgress !== undefined && (!contentProgress || record.searchTarget !== 'content')) return null;
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
      ...(record.searchTarget === 'content' ? { searchTarget: 'content' as const } : {}),
      directoryEntryOffset: record.directoryEntryOffset as number,
      ...(contentProgress ? { contentProgress } : {}),
      ...(after ? { after } : {}),
    };
  } catch {
    return null;
  }
}

function decodeActivityCandidateCursor(raw: string): ActivityCandidateCursorV3 | null {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const after = parseExternalSessionActivityPosition(record.after);
    return record.v === 3 && record.kind === 'antigravityCandidateActivity' && typeof record.brainDir === 'string' && after
      ? { v: 3, kind: 'antigravityCandidateActivity', brainDir: record.brainDir, after }
      : null;
  } catch {
    return null;
  }
}

/**
 * Unsearched Browse: every conversation's transcript mtime in one stat pass,
 * newest first, and titles read only for the rows this page serves. A cursor
 * from the retired directory-offset scan names no activity position, so it is
 * a stale source continuation (`source_invalid`).
 */
async function listAntigravityCandidatesByActivity(params: Readonly<{
  invocation: AgentExternalSessionsListCandidatesRequest;
  brainDir: string;
}>): Promise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>> {
  const request = params.invocation;
  const cursor = request.cursor ? decodeActivityCandidateCursor(request.cursor) : null;
  if (request.cursor && !cursor) {
    // A continuation of the retired directory-offset scan is stale, not malformed.
    return decodeCandidateCursor(request.cursor)?.brainDir === params.brainDir
      ? failed('source_invalid', 'Antigravity candidate cursor is stale.', true)
      : failed('invalid_request', 'Invalid Antigravity candidate cursor.');
  }
  if (cursor && cursor.brainDir !== params.brainDir) {
    return failed('invalid_request', 'Invalid Antigravity candidate cursor.');
  }
  const updatedAfterMs = request.updatedAfterMs;
  const entries = (await listAntigravityConversationActivity({ brainDir: params.brainDir, signal: request.signal }))
    .filter((entry) => updatedAfterMs === undefined || entry.updatedAtMs >= updatedAfterMs);
  let page;
  try {
    page = await pageExternalSessionCandidatesByActivity({
      entries,
      after: cursor?.after ?? null,
      limit: request.maxItems,
      signal: request.signal,
      readRows: async (rows) => await Promise.all(rows.map(async (row) => {
        const candidate = await resolveAntigravityConversationCandidate({
          brainDir: params.brainDir,
          conversationId: row.remoteSessionId,
        });
        // The listed activity is the row's place in this order; publish it.
        return candidate ? toCandidate({ ...candidate, updatedAtMs: row.updatedAtMs }) : null;
      })),
      fits: (candidates, next) => isAgentExternalSessionsResultWithinByteBudget(
        ok({ candidates, nextCursor: next ? encodeCandidateCursor({ v: 3, kind: 'antigravityCandidateActivity', brainDir: params.brainDir, after: next }) : null }),
        request.maxSerializedBytes,
      ),
    });
  } catch (error) {
    if (error instanceof ExternalSessionActivityPageBudgetError) {
      return createAgentExternalSessionsProducerOverflowFailure(
        'Antigravity candidate result cannot fit the valid serialized-byte bound.',
      );
    }
    throw error;
  }
  return boundedResult(request, ok({
    candidates: page.candidates,
    nextCursor: page.next
      ? encodeCandidateCursor({ v: 3, kind: 'antigravityCandidateActivity', brainDir: params.brainDir, after: page.next })
      : null,
  }));
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

function readContentSearchText(rawContent: unknown): string | null {
  const content = rawContent && typeof rawContent === 'object' && !Array.isArray(rawContent)
    ? rawContent as Readonly<Record<string, unknown>> : null;
  const rawData = content?.type === 'acp' ? content.data : null;
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
    ? rawData as Readonly<Record<string, unknown>> : null;
  return content?.type === 'text' && typeof content.text === 'string' ? content.text
    : data?.type === 'message' && typeof data.message === 'string' ? data.message : null;
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
  searchTarget?: 'content';
  directoryEntryOffset: number;
  contentProgress?: AntigravityContentSearchProgress;
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
    ...(params.searchTarget ? { searchTarget: params.searchTarget } : {}),
    directoryEntryOffset: params.directoryEntryOffset,
    ...(params.contentProgress ? { contentProgress: params.contentProgress } : {}),
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
  invocation: AgentExternalSessionsListCandidatesRequest;
  brainDir: string;
  searchTerm: string;
  searchTarget?: 'content';
  cursor: FullCandidateSearchCursorV2 | null;
  maxItems: number;
}>): Promise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>> {
  const limit = Math.trunc(params.maxItems);
  const after = params.searchTarget !== 'content' && params.cursor?.after
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
  const control = createExternalSessionContentSearchControl({
    signal: params.invocation.signal,
    deadlineAtMs: params.searchTarget === 'content'
      ? params.invocation.scanDeadlineAtMs ?? params.invocation.deadlineAtMs
      : params.invocation.deadlineAtMs,
  });
  let partial = false;
  let yielded = false;
  let processedOffset = params.cursor?.directoryEntryOffset ?? 0;
  let contentProgress = params.cursor?.contentProgress;
  if (contentProgress && page.candidates[0]?.conversationId !== contentProgress.conversationId) {
    throw new AntigravityCandidateSourceChangedError('Antigravity content-search candidate changed during pagination.');
  }
  const nativeFileSystem = createExternalSessionContentSearchControl({ signal: params.invocation.signal }).fileSystem;
  for (const nativeCandidate of page.candidates) {
    let candidate = toCandidate(nativeCandidate);
    if (params.searchTarget === 'content') {
      try {
        params.invocation.signal.throwIfAborted();
        const file = await stat(nativeCandidate.transcriptPath, { bigint: true });
        const sourceIdentity = `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
        const sizeBytes = Number(file.size);
        if (contentProgress && (contentProgress.sourceIdentity !== sourceIdentity || contentProgress.offsetBytes > sizeBytes)) {
          throw new AntigravityCandidateSourceChangedError('Antigravity content-search transcript changed during pagination.');
        }
        const resumed = Boolean(contentProgress);
        let progress: AntigravityContentSearchProgress = contentProgress ?? {
          conversationId: nativeCandidate.conversationId, sourceIdentity, offsetBytes: 0,
          count: 0, partial: false, pendingToolCallIds: [],
        };
        contentProgress = progress;
        let scanFinished = progress.offsetBytes === sizeBytes;
        const searched = await searchExternalSessionContent({
          query: params.searchTerm,
          ...(resumed ? {} : { paths: [nativeCandidate.transcriptPath] }),
          ripgrep: params.invocation.ripgrep,
          control,
          isScanComplete: () => scanFinished || progress.offsetBytes === sizeBytes,
          async decode(matchText) {
            await control.prepare(async () => {
              if (progress.offsetBytes >= sizeBytes) return true;
              const offsetBytes = progress.offsetBytes;
              const lines = await readJsonlFileForwardLines({ filePath: nativeCandidate.transcriptPath, offsetBytes,
                maxItems: params.maxItems, maxBytes: params.invocation.maxSerializedBytes, fileSystem: nativeFileSystem,
                onDiagnostic() { progress = { ...progress, partial: true }; contentProgress = progress; },
                onLine(line) {
                  params.invocation.signal.throwIfAborted();
                  const valid = line.value !== null && typeof line.value === 'object' && !Array.isArray(line.value);
                  const projected = projectAntigravityTranscriptRecordGroupsWithCorrelation({
                    conversationId: nativeCandidate.conversationId,
                    pendingToolCallIds: progress.pendingToolCallIds,
                    records: valid || line.endOffsetBytes < sizeBytes ? [{ record: valid ? line.value as Record<string, unknown> : {},
                      startOffsetBytes: line.startOffsetBytes, endOffsetBytes: line.endOffsetBytes }] : [],
                  });
                  const group = projected.groups[0];
                  const unsupported = Boolean(group?.unsupported);
                  const count = progress.count;
                  let match = progress.match;
                  for (const [itemIndex, item] of (group?.items ?? []).entries()) {
                    const text = readContentSearchText(item.raw.content);
                    if (!match && text !== null && matchText(text) !== null) {
                      match = { startOffsetBytes: line.startOffsetBytes, endOffsetBytes: line.endOffsetBytes,
                        itemIndex, messageIndex: count + itemIndex };
                    }
                  }
                  // Commit native byte, ordinal and correlation facts before
                  // the shared scheduler checks the cooperative deadline.
                  progress = { conversationId: progress.conversationId, sourceIdentity: progress.sourceIdentity,
                    offsetBytes: Math.min(sizeBytes, line.endOffsetBytes + 1),
                    count: count + (group?.items.length ?? 0),
                    pendingToolCallIds: projected.pendingToolCallIds,
                    partial: progress.partial || !valid || unsupported, ...(match ? { match } : {}) };
                  contentProgress = progress;
                },
              });
              control.assertNotYielded();
              progress = { ...progress, offsetBytes: lines.nextOffsetBytes,
                partial: progress.partial || lines.truncated || Boolean(lines.diagnostics?.length) };
              contentProgress = progress;
              if (lines.reachedEnd) scanFinished = true;
              if (lines.nextOffsetBytes <= offsetBytes) {
                progress = { ...progress, partial: true };
                contentProgress = progress;
                scanFinished = true;
              }
              return scanFinished || progress.offsetBytes === sizeBytes;
            });
            // Opaque cursor data holds locations, never authoritative text.
            // Finalization re-decodes the native row under hard cancellation.
            const row = progress.match;
            const lines = row ? await readJsonlFileForwardLines({ filePath: nativeCandidate.transcriptPath,
              offsetBytes: row.startOffsetBytes, maxItems: 1,
              maxBytes: Math.max(1, row.endOffsetBytes - row.startOffsetBytes + 1), fileSystem: nativeFileSystem }) : null;
            params.invocation.signal.throwIfAborted();
            const line = lines?.items[0];
            const items = line && row && line.startOffsetBytes === row.startOffsetBytes && line.endOffsetBytes === row.endOffsetBytes
              && line.value && typeof line.value === 'object' && !Array.isArray(line.value)
              ? projectAntigravityTranscriptRecordsToExternalItems({ conversationId: nativeCandidate.conversationId,
                records: [{ record: line.value as Record<string, unknown>, startOffsetBytes: line.startOffsetBytes,
                  endOffsetBytes: line.endOffsetBytes }] }) : [];
            const item = row ? items[row.itemIndex] : undefined;
            const text = item ? readContentSearchText(item.raw.content) : null;
            const snippet = text !== null ? matchText(text) : null;
            return { records: item && row && snippet !== null ? [{ id: item.id, snippet, messageIndex: row.messageIndex }] : [],
              partial: progress.partial };
          },
        });
        const finalFile = await stat(nativeCandidate.transcriptPath, { bigint: true });
        if (`${finalFile.dev}:${finalFile.ino}:${finalFile.size}:${finalFile.mtimeNs}:${finalFile.ctimeNs}` !== sourceIdentity) {
          throw new AntigravityCandidateSourceChangedError('Antigravity content-search transcript changed while scanning.');
        }
        params.invocation.signal.throwIfAborted();
        contentProgress = undefined;
        partial ||= searched.partial;
        processedOffset = nativeCandidate.directoryEntryOffset;
        if (!searched.match) continue;
        candidate = { ...candidate, match: searched.match, ...(!searched.partial ? { messageCount: progress.count } : {}) };
      } catch (error) {
        if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
        yielded = true;
        partial = true;
        break;
      }
    } else if (
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

  const exhausted = !yielded && page.nextDirectoryEntryOffset === null;
  const nextOffset = yielded ? processedOffset : page.nextDirectoryEntryOffset;
  let nextCursor: string | null = null;
  if (!exhausted && nextOffset !== null) {
    const sourceGeneration = page.sourceGeneration;
    if (!sourceGeneration) {
      return failed('agent_error', 'Antigravity candidate continuation cannot be represented.', false);
    }
    // The anchor moves to the newest match this chunk served; a chunk without
    // a match carries the previous anchor, or none until a first match serves.
    // Content walks physical directory offsets. A newer transcript in a later
    // directory chunk is still unsearched, regardless of its recency.
    const servedAnchor = params.searchTarget === 'content' ? undefined : retained.at(-1) ?? after ?? undefined;
    nextCursor = encodeFullCandidateSearchCursor({
      brainDir: params.brainDir,
      sourceGeneration,
      searchTerm: params.searchTerm,
      ...(params.searchTarget ? { searchTarget: params.searchTarget } : {}),
      directoryEntryOffset: nextOffset,
      ...(contentProgress ? { contentProgress } : {}),
      ...(servedAnchor ? { after: servedAnchor } : {}),
    });
    if (!nextCursor) {
      return failed('agent_error', 'Antigravity candidate continuation cannot be represented.', false);
    }
  }

  return boundedResult(params.invocation, ok({
    candidates: retained,
    nextCursor,
    ...(params.searchTarget === 'content' ? { contentCoverage: partial || !exhausted ? 'partial' as const : 'complete' as const } : {}),
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
  // Report fallback and deliberate-omission facts once the native window is
  // retired, so replaying a projected item page cannot inflate the counts.
  const skippedPositions = windowDrained
    ? groups.filter((group) => group.unsupported).map((group) => group.startOffsetBytes)
    : [];
  const nonTranscriptPositions = windowDrained
    ? groups.filter((group) => group.items.length === 0 && !group.unsupported).map((group) => group.startOffsetBytes)
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
                      code: 'external_sessions_transcript_unsupported_record',
                      severity: 'benign' as const,
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
      return outcome.code === 'JSONL_RECORD_TOO_LARGE'
        ? failed('agent_error', outcome.error, false)
        : ok({ outcome: 'read_failed' });
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
      if (request.includeAccountingSource === false) return boundedResult(request, ok({ source: validation.value.source }));
      const { brainDir } = validation.value;
      const inventory = await discoverAgentAccountingJsonlSource([brainDir], request.signal);
      return boundedResult(request, ok({ source: validation.value.source, accountingSource: {
        rootPath: brainDir, rootField: 'brainDir',
        resourceKey: `antigravity:transcripts:${createHash('sha256').update(brainDir).digest('base64url')}`,
        changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files: [...inventory.files], topologyDirectories: [...inventory.topologyDirectories] },
      } }));
    },

    async listCandidates(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) return failed('invalid_request');
      const validation = await validateSource({ source: request.source, env: readEnv() });
      if (!validation.ok) return boundedResult(request, validation);
      const contentSearch = request.searchTarget === 'content';
      const searchTerm = contentSearch ? request.searchTerm ?? '' : request.searchTerm?.trim().toLowerCase() ?? '';
      if (contentSearch && !searchTerm) return failed('invalid_request', 'Content search requires a query.');
      const fullSearch = searchTerm.length > 0 && (request.searchMode === 'full' || contentSearch);
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
          || fullSearchCursor.searchTarget !== (contentSearch ? 'content' : undefined)
        )
      ) {
        return failed('invalid_request', 'Invalid Antigravity full-search candidate cursor.');
      }
      const browse = !searchTerm;
      const decoded = fullSearch || browse ? null : request.cursor ? decodeCandidateCursor(request.cursor) : null;
      if (!fullSearch && !browse && request.cursor && (!decoded || decoded.brainDir !== validation.value.brainDir)) {
        return failed('invalid_request', 'Invalid Antigravity candidate cursor.');
      }
      try {
        if (fullSearch) {
          return await listFullCandidateSearch({
            invocation: request,
            brainDir: validation.value.brainDir,
            searchTerm,
            ...(contentSearch ? { searchTarget: 'content' as const } : {}),
            cursor: fullSearchCursor,
            maxItems: request.maxItems,
          });
        }
        if (browse) {
          return await listAntigravityCandidatesByActivity({
            invocation: request,
            brainDir: validation.value.brainDir,
          });
        }
        const page = await pageAntigravityConversationCandidates({
          brainDir: validation.value.brainDir,
          afterDirectoryEntryOffset: decoded?.directoryEntryOffset,
          expectedSourceGeneration: decoded?.sourceGeneration,
          maxItems: request.maxItems,
          signal: request.signal,
        });
        const filtered = page.candidates.filter((candidate) => (
          candidate.conversationId.toLowerCase().includes(searchTerm)
          || candidate.title?.toLowerCase().includes(searchTerm)
        ));
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
            searchIncomplete: true,
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
              searchIncomplete: true,
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
          searchIncomplete: true,
        });
        return boundedResult(request, result);
      } catch (error) {
        const after = getAgentExternalSessionsInvocationFailure(request);
        if (after) return after;
        if (isPluginError(error) && error.code === 'JSONL_RECORD_TOO_LARGE') return failed('agent_error', error.message, false);
        if (error instanceof AntigravityCandidateSourceChangedError) {
          return boundedResult(request, failed('source_invalid', error.message, true));
        }
        return boundedResult(request, failed(
          'agent_error',
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
      if (outcome.kind === 'read_failed') return boundedResult(request, failed('agent_error', outcome.error,
        outcome.code === 'JSONL_RECORD_TOO_LARGE' ? false : undefined));
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
      const windowItems = groups.flatMap((group) => group.items);
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
      const nextCursor = !windowDrained
        ? encodeAntigravityExternalPageCursor({
          v: 1,
          kind: 'antigravityExternalPage',
          nativeCursor: pageCursor?.nativeCursor ?? null,
          nativeMaxItems,
          nativeMaxBytes,
          itemEnd: itemStart,
        })
        : outcome.nextCursor === null
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
        ...(windowDrained && groups.some((group) => group.unsupported) ? { diagnostics: [{
          code: 'external_sessions_transcript_unsupported_record',
          severity: 'benign' as const,
          count: groups.filter((group) => group.unsupported).length,
          positions: groups.filter((group) => group.unsupported).map((group) => group.startOffsetBytes).slice(0, 200),
        }] } : {}),
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
