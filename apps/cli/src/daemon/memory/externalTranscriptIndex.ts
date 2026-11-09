import type { AgentExternalSessionTranscriptItem, AgentExternalSessionTerminalObservation, AgentExternalSessionsPageTranscriptRequest, AgentExternalSessionsReadAfterDiagnostic } from '@happier-dev/plugin-sdk/sessions/external';
import type { MemoryContentPolicyV1, MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import { MemoryNativeReadFailureReasonV1Schema, type MemoryIndexSourceStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';
import { isAgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY, type BoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import type { SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import { logger } from '@/ui/logger';
import { setImmediate } from 'node:timers/promises';
import { extractMemoryIndexableTranscriptItemFromDecryptedRow } from './transcript/extractIndexableItem';
import { applyMemoryCoveragePolicy, memoryIndexPolicyKey, resolveMemoryIndexPolicy, resolveMemoryCoverageCreatedAtCutoffMs } from './transcript/coveragePolicy';

export function externalMemoryStorageId(source: MemoryExternalTranscriptSourceV1): string {
  return JSON.stringify(['external_transcript', source.agentId, source.sourceKey, source.nativeSessionId]);
}

/** Native cursors share failure storage, but never identify Happier Sessions. */
export function isExternalMemoryStorageId(value: string): boolean {
  if (!value.startsWith('[')) return false;
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) && decoded.length === 4 && decoded[0] === 'external_transcript'
      && decoded.slice(1).every(part => typeof part === 'string');
  } catch { return false; }
}

/** Keep the host's closed diagnostic tokens; never log a plugin's free text. */
export function memoryExternalSourceReadError(source: Readonly<{ agentId: string; sourceKey: string }>, failure: Readonly<{ code: string; message?: string }>) {
  const parsed = MemoryNativeReadFailureReasonV1Schema.safeParse(failure.message);
  const reason = parsed.success ? parsed.data : 'external_sessions_operation_rejected';
  logger.debug('[memoryWorker] Native source read failed', { agentId: source.agentId,
    code: failure.code, ...(reason ? { reason } : {}) });
  return Object.assign(new Error(reason ? `${failure.code}:${reason}` : failure.code), { code: failure.code, reason });
}

export function memoryExternalSourceFailure(error: unknown): Pick<MemoryIndexSourceStatusV1, 'errorCode' | 'errorReason'> {
  const record = error && typeof error === 'object' ? error as { code?: unknown; reason?: unknown } : null;
  const reason = MemoryNativeReadFailureReasonV1Schema.safeParse(record?.reason);
  return { errorCode: isAgentExternalSessionsFailureCode(record?.code) ? record.code : 'agent_error',
    errorReason: reason.success ? reason.data : 'external_sessions_operation_rejected' };
}

const unreadableTranscriptFailure = { errorCode: 'unsupported', errorReason: 'external_sessions_transcript_read_failed' } as const;

/** The existing opaque frontier also retains an unavailable read across child lifetimes. */
export function readExternalMemoryUnavailableFailure(cursor: string | null | undefined) {
  return cursor && (JSON.parse(cursor) as { type?: unknown }).type === 'unavailable' ? unreadableTranscriptFailure : undefined;
}

export function resolveExternalMemoryIndexPolicy(settings: MemorySettingsV1): Readonly<{
  policy: ReturnType<typeof resolveMemoryIndexPolicy>;
  key: string;
}> {
  const external = settings.conversationSearch.indexExternal;
  // Native opt-in has its own history window. Happier's new_only backfill
  // cannot exclude native conversations that predate enabling this index.
  const policy = resolveMemoryIndexPolicy({ ...settings, backfillPolicy: 'all_history',
    contentPolicy: { ...settings.contentPolicy, includeToolOutputs: external.includeToolOutput } });
  return { policy, key: JSON.stringify([memoryIndexPolicyKey(policy), external.historyDays]) };
}

/** Native records share the memory owner's semantic admission and redaction. */
export function extractExternalMemoryTranscriptItems(
  items: readonly (AgentExternalSessionTranscriptItem | AgentExternalSessionTerminalObservation)[],
  contentPolicy: Partial<MemoryContentPolicyV1>,
) {
  return items.flatMap((item, index) => {
    if (item.raw.role === 'source_observation' || ('sidechainId' in item && item.sidechainId)) return [];
    if (item.raw.role !== 'user' && item.raw.role !== 'agent') return [];
    const extracted = extractMemoryIndexableTranscriptItemFromDecryptedRow({ sessionId: 'external', index,
      row: { seq: index + 1, createdAtMs: item.createdAtMs, role: item.raw.role, content: item.raw.content },
      contentPolicy });
    return extracted ? [{ sourceItemId: item.id, createdAtMs: extracted.createdAtMs, text: extracted.text,
      role: extracted.role, ordinal: index + 1 }] : [];
  });
}

export type MemoryExternalSourceReader = Readonly<{
  agentId: string;
  sourceKey: string;
  source: AgentExternalSessionSource;
  reader: Pick<BoundedAgentExternalSessionsContribution, 'pageTranscript' | 'readAfterTranscript' | 'listCandidates' | 'resolveLinkIdentity'>;
  observation?: AgentExternalSessionsPageTranscriptRequest['observation'];
  readObservation?(): AgentExternalSessionsPageTranscriptRequest['observation'];
}>;

type Frontier = Readonly<{ type: 'page' | 'tail' | 'unavailable'; cursor?: string; tailCursor?: string }>;

/** Runs only the candidates already selected by the worker's shared tick budget. */
export async function syncExternalMemoryTranscriptsBatch(input: Readonly<
  Omit<Parameters<typeof syncExternalMemoryTranscriptOnce>[0], 'source' | 'native'> & {
    candidates: readonly Readonly<{ source: MemoryExternalTranscriptSourceV1; native: MemoryExternalSourceReader }>[];
    tier1?: Pick<SummaryShardIndexDbHandle, 'getSessionCursors' | 'markDeepIndexFailure' | 'markDeepIndexSuccess'>;
    onSourceResult?(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error', failure?: Pick<MemoryIndexSourceStatusV1, 'errorCode' | 'errorReason'>): void;
  }
>): Promise<void> {
  const { candidates, onSourceResult, tier1, ...operation } = input;
  operation.signal.throwIfAborted();
  for (const candidate of candidates) {
    operation.signal.throwIfAborted();
    const sessionId = externalMemoryStorageId(candidate.source);
    const failureState = tier1?.getSessionCursors({ sessionId, nowMs: operation.nowMs, readOnly: true });
    if (failureState && failureState.nextDeepEligibleAtMs > operation.nowMs) {
      // A fresh demand child has no predecessor traversal Map. Persisted
      // backoff defers this source; it is not an admitted continuation.
      onSourceResult?.(candidate.source, 'error', readExternalMemoryUnavailableFailure(operation.db.getExternalSourceState({ sessionId })?.cursor));
      continue;
    }
    try {
      const result = await syncExternalMemoryTranscriptOnce({ ...operation, ...candidate });
      if (failureState?.consecutiveDeepFailures) tier1?.markDeepIndexSuccess({ sessionId, seqTo: 0, nowMs: operation.nowMs });
      onSourceResult?.(candidate.source, result);
    }
    catch (error) {
      operation.signal.throwIfAborted();
      tier1?.markDeepIndexFailure({ sessionId, nowMs: operation.nowMs,
        backoffBaseMs: operation.settings.deep.failureBackoffBaseMs,
        backoffMaxMs: operation.settings.deep.failureBackoffMaxMs });
      onSourceResult?.(candidate.source, 'error', memoryExternalSourceFailure(error));
    }
    operation.signal.throwIfAborted();
  }
}

/** One bounded page per existing memory-worker turn; native cursors stay opaque. */
export async function syncExternalMemoryTranscriptOnce(input: Readonly<{
  source: MemoryExternalTranscriptSourceV1;
  native: MemoryExternalSourceReader;
  db: DeepIndexDbHandle;
  settings: MemorySettingsV1;
  nowMs: number;
  signal: AbortSignal;
  embedDocuments?: (texts: readonly string[], signal?: AbortSignal) => Promise<Float32Array[]>;
  embeddings?: Readonly<{ providerKind: string; modelId: string }> | null;
}>): Promise<'current' | 'more' | 'removed'> {
  input.signal.throwIfAborted();
  const sessionId = externalMemoryStorageId(input.source);
  const external = input.settings.conversationSearch.indexExternal;
  const { policy, key: policyKey } = resolveExternalMemoryIndexPolicy(input.settings);
  const contentPolicy = policy.contentPolicy;
  if (input.db.hasSessionArtifactsOutsidePolicy({ sessionId, policyKey })) input.db.deleteSessionIndexData({ sessionId });
  const state = input.db.getExternalSourceState({ sessionId });
  let frontier: Frontier = state?.cursor ? JSON.parse(state.cursor) : { type: 'page' };
  // Normal worker retry/observation can recover it; it is not a sticky partial bit.
  if (frontier.type === 'unavailable') frontier = { type: 'page' };
  // Readers without a tail watermark can refresh only from the page head.
  // That read replaces their snapshot; it is not an append at new ordinals.
  const restartSnapshot = frontier.type === 'tail' && !frontier.cursor;
  if (restartSnapshot) frontier = { type: 'page' };
  const effectiveCutoff = resolveMemoryCoverageCreatedAtCutoffMs({ policy: policy.coveragePolicy,
    nowMs: input.nowMs, enabledAtMs: policy.enabledAtMs, historyDays: external.historyDays });
  input.db.pruneSessionArtifacts({ sessionId, policyKey, ...(effectiveCutoff === null ? {} : { createdAtCutoffMs: effectiveCutoff }) });
  const observation = input.native.readObservation?.() ?? input.native.observation;
  const operation = { source: input.native.source, remoteSessionId: input.source.nativeSessionId,
    ...(observation ? { observation } : {}),
    maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems,
    maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes, signal: input.signal };
  let pageCursor: string | undefined;
  let items: readonly (AgentExternalSessionTranscriptItem | AgentExternalSessionTerminalObservation)[];
  let diagnostics: readonly AgentExternalSessionsReadAfterDiagnostic[] | undefined;
  let nextFrontier: Frontier;
  let hasMore: boolean;
  if (frontier.type === 'tail' && frontier.cursor) {
    const result = await input.native.reader.readAfterTranscript({ ...operation, cursor: frontier.cursor });
    input.signal.throwIfAborted();
    if (!result.ok) throw memoryExternalSourceReadError(input.source, result);
    if (result.value.outcome === 'already_current') return 'current';
    if (result.value.outcome === 'source_unavailable') {
      input.db.deleteSessionIndexData({ sessionId });
      return 'removed';
    }
    if (result.value.outcome === 'source_replaced' || result.value.outcome === 'gap_or_cursor_expired') {
      input.db.deleteSessionIndexData({ sessionId, retainExternalSource: true });
      return 'more';
    }
    if (result.value.outcome !== 'advanced') throw new Error('memory_external_transcript_read_failed');
    items = result.value.items;
    diagnostics = result.value.diagnostics;
    nextFrontier = { type: 'tail', cursor: result.value.nextCursor };
    hasMore = result.value.hasMore;
  } else {
    pageCursor = frontier.cursor;
    const result = await input.native.reader.pageTranscript({ ...operation, direction: 'older', ...(pageCursor ? { cursor: pageCursor } : {}) });
    input.signal.throwIfAborted();
    if (!result.ok) {
      if (result.code === 'candidate_not_found') {
        input.db.deleteSessionIndexData({ sessionId });
        return 'removed';
      }
      throw memoryExternalSourceReadError(input.source, result);
    }
    items = result.value.items;
    diagnostics = result.value.diagnostics;
    hasMore = result.value.hasMore === true || result.value.truncated === true;
    if (hasMore && !result.value.nextCursor) throw new Error('memory_external_transcript_missing_continuation');
    const tailCursor = frontier.tailCursor ?? result.value.tailCursor ?? undefined;
    nextFrontier = hasMore && result.value.nextCursor
      ? { type: 'page', cursor: result.value.nextCursor, ...(tailCursor ? { tailCursor } : {}) }
      : { type: 'tail', ...(tailCursor ? { cursor: tailCursor } : {}) };
  }
  if (diagnostics?.some(diagnostic => diagnostic.severity === 'required')) {
    // This decoder cannot represent the conversation. A scan uses the same
    // decoder, so expose an unavailable read, not incomplete indexed coverage.
    input.db.deleteSessionIndexData({ sessionId });
    input.db.setExternalSourceState({ sessionId, source: input.source, cursor: JSON.stringify({ type: 'unavailable' }), nextOrdinal: 1 });
    throw memoryExternalSourceReadError(input.source, { code: unreadableTranscriptFailure.errorCode, message: unreadableTranscriptFailure.errorReason });
  }
  // Preserve the previous searchable snapshot when the boundary read fails.
  // Once a replacement page is available, retire its old text and cursor as
  // one projection through the existing source-removal owner.
  if (restartSnapshot) input.db.deleteSessionIndexData({ sessionId });
  const nextOrdinal = restartSnapshot ? 1 : state?.nextOrdinal ?? 1;
  const semanticItems = extractExternalMemoryTranscriptItems(items, contentPolicy);
  const extracted = semanticItems.map((item, index) => ({ ...item, seq: nextOrdinal + index,
    sourceOrder: frontier.type === 'tail' ? nextOrdinal + index : -(nextOrdinal - 1) - semanticItems.length + index }));
  const indexable = applyMemoryCoveragePolicy({ items: extracted, policy: policy.coveragePolicy,
    nowMs: input.nowMs, enabledAtMs: policy.enabledAtMs, backfillPolicy: policy.backfillPolicy });
  for (const item of indexable) {
    input.signal.throwIfAborted();
    if (effectiveCutoff !== null && item.createdAtMs < effectiveCutoff) continue;
    input.db.insertChunk({ sessionId, source: input.source, sourceItemId: item.sourceItemId,
      sourceOrder: item.sourceOrder,
      ...(pageCursor ? { sourceCursor: pageCursor } : {}), seqFrom: item.seq, seqTo: item.seq,
      createdAtFromMs: item.createdAtMs, createdAtToMs: item.createdAtMs, text: item.text, policyKey });
    // FTS/tokenization and SQLite commits are synchronous. Let daemon RPCs and
    // cancellation run between records instead of monopolizing a whole page.
    await setImmediate();
  }
  input.signal.throwIfAborted();
  if (policy.coveragePolicy.type === 'latest_messages') {
    input.db.pruneExternalSourceChunks({ sessionId, maxSemanticMessages: policy.coveragePolicy.maxSemanticMessagesPerSession });
    if (frontier.type === 'page' && nextOrdinal - 1 + semanticItems.length >= policy.coveragePolicy.maxSemanticMessagesPerSession) {
      hasMore = false;
      nextFrontier = { type: 'tail', ...(nextFrontier.tailCursor ? { cursor: nextFrontier.tailCursor } : nextFrontier.type === 'tail' && nextFrontier.cursor ? { cursor: nextFrontier.cursor } : {}) };
    }
  }
  if (frontier.type === 'page' && effectiveCutoff !== null && extracted.some(item => item.createdAtMs < effectiveCutoff)) {
    hasMore = false;
    nextFrontier = { type: 'tail', ...(nextFrontier.tailCursor ? { cursor: nextFrontier.tailCursor } : nextFrontier.type === 'tail' && nextFrontier.cursor ? { cursor: nextFrontier.cursor } : {}) };
  }
  // Text and opaque page progress belong to the source projection, not to
  // optional embedding-service custody. Stop during embeddings keeps both.
  input.db.setExternalSourceState({ sessionId, source: input.source, cursor: JSON.stringify(nextFrontier), nextOrdinal: nextOrdinal + semanticItems.length });
  if (input.embedDocuments && input.embeddings) {
    const chunks = input.db.listChunksWithoutEmbeddings({ sessionId, provider: input.embeddings.providerKind,
      modelId: input.embeddings.modelId, limit: operation.maxItems });
    try {
      const vectors = chunks.length ? await input.embedDocuments(chunks.map(chunk => chunk.text), input.signal) : [];
      input.signal.throwIfAborted();
      if (vectors.length === chunks.length) chunks.forEach((chunk, index) => {
        const embedding = vectors[index];
        if (embedding instanceof Float32Array && embedding.length) input.db.upsertEmbedding({ ...chunk,
          provider: input.embeddings!.providerKind, modelId: input.embeddings!.modelId, embedding, updatedAtMs: input.nowMs });
      });
    } catch (error) {
      input.signal.throwIfAborted();
      logger.debug('[memoryWorker] Missing native chunk embeddings backfill failed (best-effort)', {
        sessionId, message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return hasMore ? 'more' : 'current';
}
