import type { AgentExternalSessionTranscriptItem, AgentExternalSessionTerminalObservation } from '@happier-dev/plugin-sdk/sessions/external';
import type { MemoryContentPolicyV1, MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryExternalTranscriptSourceV1 } from '@happier-dev/protocol/memory/memorySearch';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY, type BoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';
import { logger } from '@/ui/logger';
import { extractMemoryIndexableTranscriptItemFromDecryptedRow } from './transcript/extractIndexableItem';
import { applyMemoryCoveragePolicy, memoryIndexPolicyKey, resolveMemoryIndexPolicy, resolveMemoryCoverageCreatedAtCutoffMs } from './transcript/coveragePolicy';

export function externalMemoryStorageId(source: MemoryExternalTranscriptSourceV1): string {
  return JSON.stringify(['external_transcript', source.agentId, source.sourceKey, source.nativeSessionId]);
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
}>;

type Frontier = Readonly<{ type: 'page' | 'tail'; cursor?: string; tailCursor?: string }>;

/** Runs only the candidates already selected by the worker's shared tick budget. */
export async function syncExternalMemoryTranscriptsBatch(input: Readonly<
  Omit<Parameters<typeof syncExternalMemoryTranscriptOnce>[0], 'source' | 'native'> & {
    candidates: readonly Readonly<{ source: MemoryExternalTranscriptSourceV1; native: MemoryExternalSourceReader }>[];
    onSourceResult?(source: MemoryExternalTranscriptSourceV1, state: 'current' | 'more' | 'removed' | 'error'): void;
  }
>): Promise<void> {
  const { candidates, onSourceResult, ...operation } = input;
  const errors: unknown[] = [];
  operation.signal.throwIfAborted();
  for (const candidate of candidates) onSourceResult?.(candidate.source, 'more');
  for (const candidate of candidates) {
    operation.signal.throwIfAborted();
    try {
      const result = await syncExternalMemoryTranscriptOnce({ ...operation, ...candidate });
      onSourceResult?.(candidate.source, result);
    }
    catch (error) {
      onSourceResult?.(candidate.source, 'error');
      operation.signal.throwIfAborted();
      errors.push(error);
    }
    operation.signal.throwIfAborted();
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'memory_external_transcript_sources_failed');
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
  const contentPolicy = { ...input.settings.contentPolicy, includeToolOutputs: external.includeToolOutput };
  const policy = resolveMemoryIndexPolicy({ ...input.settings, contentPolicy });
  const policyKey = JSON.stringify([memoryIndexPolicyKey(policy), external.historyDays]);
  if (input.db.hasSessionArtifactsOutsidePolicy({ sessionId, policyKey })) input.db.deleteSessionIndexData({ sessionId });
  const state = input.db.getExternalSourceState({ sessionId });
  const frontier: Frontier = state?.cursor ? JSON.parse(state.cursor) : { type: 'page' };
  const cutoff = resolveMemoryCoverageCreatedAtCutoffMs({ policy: policy.coveragePolicy, nowMs: input.nowMs, enabledAtMs: policy.enabledAtMs });
  const historyCutoff = external.historyDays === null ? null : Math.max(0, input.nowMs - external.historyDays * 86_400_000);
  const effectiveCutoff = cutoff === null ? historyCutoff : historyCutoff === null ? cutoff : Math.max(cutoff, historyCutoff);
  input.db.pruneSessionArtifacts({ sessionId, policyKey, ...(effectiveCutoff === null ? {} : { createdAtCutoffMs: effectiveCutoff }) });
  const operation = { source: input.native.source, remoteSessionId: input.source.nativeSessionId,
    maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxItems,
    maxSerializedBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript.maxSerializedBytes, signal: input.signal };
  let pageCursor: string | undefined;
  let items: readonly (AgentExternalSessionTranscriptItem | AgentExternalSessionTerminalObservation)[];
  let nextFrontier: Frontier;
  let hasMore: boolean;
  if (frontier.type === 'tail' && frontier.cursor) {
    const result = await input.native.reader.readAfterTranscript({ ...operation, cursor: frontier.cursor });
    input.signal.throwIfAborted();
    if (!result.ok) throw new Error(result.code);
    if (result.value.outcome === 'already_current') return 'current';
    if (result.value.outcome === 'source_unavailable') {
      input.db.deleteSessionIndexData({ sessionId });
      return 'removed';
    }
    if (result.value.outcome === 'source_replaced' || result.value.outcome === 'gap_or_cursor_expired') {
      input.db.deleteSessionIndexData({ sessionId });
      return 'more';
    }
    if (result.value.outcome !== 'advanced') throw new Error('memory_external_transcript_read_failed');
    items = result.value.items;
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
      throw new Error(result.code);
    }
    items = result.value.items;
    hasMore = result.value.hasMore === true || result.value.truncated === true;
    if (hasMore && !result.value.nextCursor) throw new Error('memory_external_transcript_missing_continuation');
    const tailCursor = frontier.tailCursor ?? result.value.tailCursor ?? undefined;
    nextFrontier = hasMore && result.value.nextCursor
      ? { type: 'page', cursor: result.value.nextCursor, ...(tailCursor ? { tailCursor } : {}) }
      : { type: 'tail', ...(tailCursor ? { cursor: tailCursor } : {}) };
  }
  const nextOrdinal = state?.nextOrdinal ?? 1;
  const semanticItems = extractExternalMemoryTranscriptItems(items, contentPolicy);
  const extracted = semanticItems.map((item, index) => ({ ...item, seq: nextOrdinal + index,
    sourceOrder: frontier.type === 'tail' ? nextOrdinal + index : -(nextOrdinal - 1) - semanticItems.length + index }));
  const indexable = applyMemoryCoveragePolicy({ items: extracted, policy: policy.coveragePolicy,
    nowMs: input.nowMs, enabledAtMs: policy.enabledAtMs, backfillPolicy: policy.backfillPolicy });
  for (const item of indexable) {
    if (effectiveCutoff !== null && item.createdAtMs < effectiveCutoff) continue;
    input.db.insertChunk({ sessionId, source: input.source, sourceItemId: item.sourceItemId,
      sourceOrder: item.sourceOrder,
      ...(pageCursor ? { sourceCursor: pageCursor } : {}), seqFrom: item.seq, seqTo: item.seq,
      createdAtFromMs: item.createdAtMs, createdAtToMs: item.createdAtMs, text: item.text, policyKey });
  }
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
