import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import type { MemoryContentPolicyV1, MemoryCoveragePolicyV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import type { SummaryShardIndexDbHandle } from '../summaryShardIndexDb';
import type { DeepIndexDbHandle } from './deepIndexDb';
import { chunkTranscriptRows } from './chunkTranscriptRows';
import type { OperationalMemoryEmbeddingsSettings } from '../resolveOperationalMemoryEmbeddingsSettings';
import {
  extractMemoryIndexableTranscriptItemFromDecryptedRow,
} from '../transcript/extractIndexableItem';
import {
  applyMemoryCoveragePolicy,
  memoryIndexPolicyKey,
  resolveMemoryCoverageCreatedAtCutoffMs,
  resolveMemoryIndexPolicy,
} from '../transcript/coveragePolicy';

export type SyncDeepIndexSettings = Readonly<{
  enabled: boolean;
  enabledAtMs?: number;
  indexMode: 'deep';
  backfillPolicy?: 'new_only' | 'last_30_days' | 'all_history';
  coveragePolicy?: MemoryCoveragePolicyV1;
  contentPolicy?: MemoryContentPolicyV1;
  deep: Readonly<{
    maxChunkChars: number;
    maxChunkMessages: number;
    minChunkMessages: number;
    includeAssistantAcpMessage: boolean;
    failureBackoffBaseMs: number;
    failureBackoffMaxMs: number;
  }>;
  embeddings?: OperationalMemoryEmbeddingsSettings | null;
  forceSnapshot?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shouldSkipAssistantAcpPayload(
  content: unknown,
  includeAssistantAcpMessage: boolean,
): boolean {
  if (includeAssistantAcpMessage) return false;
  if (!isRecord(content)) return false;
  if (content.type !== 'acp' && content.type !== 'codex') return false;
  const data = isRecord(content.data) ? content.data : null;
  return data?.type === 'message' || data?.type === 'reasoning';
}

export async function syncDeepIndexForSessionsOnce(params: Readonly<{
  sessionIds: readonly string[];
  tier1: SummaryShardIndexDbHandle;
  deep: DeepIndexDbHandle;
  settings: SyncDeepIndexSettings;
  now: () => number;
  fetchDecryptedTranscriptPageAfterSeq: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number; signal?: AbortSignal }>) => Promise<DecryptedTranscriptRow[]>;
  fetchRecentDecryptedRows?: (sessionId: string, signal?: AbortSignal) => Promise<DecryptedTranscriptRow[]>;
  embedDocuments?: (texts: readonly string[], signal?: AbortSignal) => Promise<Float32Array[]>;
  signal?: AbortSignal;
}>): Promise<ReadonlySet<string>> {
  const completedSessionIds = new Set<string>();
  if (!params.settings.enabled) return completedSessionIds;
  if (params.settings.indexMode !== 'deep') return completedSessionIds;
  const nowMs = Math.max(0, Math.trunc(params.now()));
  const memoryPolicy = resolveMemoryIndexPolicy(params.settings);
  const policyKey = memoryIndexPolicyKey(memoryPolicy);
  const pageLimit = Math.max(1, Math.min(500, Math.trunc(configuration.memoryMaxTranscriptWindowMessages)));
  const run = {
    sessionsConsidered: 0,
    sessionsProcessed: 0,
    sessionsIndexed: 0,
    sessionsFailed: 0,
    rawRowsFetched: 0,
    semanticRowsFound: 0,
    deepChunksCreated: 0,
  };

  for (const rawSessionId of params.sessionIds) {
    params.signal?.throwIfAborted();
    const sessionId = String(rawSessionId ?? '').trim();
    if (!sessionId) continue;
    run.sessionsConsidered += 1;

    const cursors = params.tier1.getSessionCursors({ sessionId, nowMs });
    if (cursors.nextDeepEligibleAtMs > nowMs) continue;

    const afterSeq = Math.max(0, Math.trunc(cursors.lastDeepIndexedSeq));
    let rows: DecryptedTranscriptRow[] = [];
    const needsBoundedSnapshot = params.settings.coveragePolicy?.type !== 'full'
      || params.settings.backfillPolicy === 'new_only'
      || params.settings.forceSnapshot === true
      || params.deep.hasSessionArtifactsOutsidePolicy({ sessionId, policyKey });
    try {
      rows = needsBoundedSnapshot && params.fetchRecentDecryptedRows
        ? await params.fetchRecentDecryptedRows(sessionId, params.signal)
        : await params.fetchDecryptedTranscriptPageAfterSeq({
          sessionId,
          afterSeq,
          limit: pageLimit,
          ...(params.signal ? { signal: params.signal } : {}),
        });
      params.signal?.throwIfAborted();
    } catch (error) {
      params.signal?.throwIfAborted();
      params.tier1.markDeepIndexFailure({
        sessionId,
        nowMs,
        backoffBaseMs: params.settings.deep.failureBackoffBaseMs,
        backoffMaxMs: params.settings.deep.failureBackoffMaxMs,
      });
      run.sessionsFailed += 1;
      if (params.settings.forceSnapshot === true) throw error;
      continue;
    }
    run.rawRowsFetched += rows.length;
    if (rows.length > 0) run.sessionsProcessed += 1;
    const lastScannedSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : afterSeq;

    try {
      // A successfully read snapshot replaces the derived projection. Edits
      // can change chunk ranges without advancing the Session sequence.
      if (needsBoundedSnapshot && params.fetchRecentDecryptedRows) {
        params.deep.deleteSessionIndexData({ sessionId });
        if (params.settings.forceSnapshot === true) {
          params.tier1.pruneSessionArtifacts({ sessionId, policyKey: `${policyKey}:edited` });
        }
      }
      const extracted = rows
        .filter((row) => !shouldSkipAssistantAcpPayload(
          row.content,
          params.settings.deep.includeAssistantAcpMessage,
        ))
        .map((row, index) => extractMemoryIndexableTranscriptItemFromDecryptedRow({
          sessionId,
          row,
          index,
          contentPolicy: params.settings.contentPolicy,
        }))
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => ({
          seq: item.seq,
          createdAtMs: item.createdAtMs,
          text: item.text,
          role: item.role === 'user' ? 'user' as const : 'agent' as const,
        }));
      const indexable = applyMemoryCoveragePolicy({
        items: extracted,
        policy: params.settings.coveragePolicy,
        nowMs,
        enabledAtMs: params.settings.enabledAtMs ?? 0,
        backfillPolicy: params.settings.backfillPolicy,
      });
      const coverageCutoffMs = resolveMemoryCoverageCreatedAtCutoffMs({
        policy: params.settings.coveragePolicy,
        nowMs,
        enabledAtMs: params.settings.enabledAtMs ?? 0,
      });
      const pruned = params.deep.pruneSessionArtifacts({
        sessionId,
        policyKey,
        ...(params.settings.coveragePolicy?.type === 'latest_messages' && indexable.length > 0
          ? { minSeq: indexable[0]!.seq }
          : {}),
        ...(coverageCutoffMs !== null ? { createdAtCutoffMs: coverageCutoffMs } : {}),
      });
      if (pruned) {
        params.tier1.rewindSessionCursor({
          sessionId,
          lane: 'deep',
          seq: Math.max(0, (indexable[0]?.seq ?? 1) - 1),
        });
      }
      run.semanticRowsFound += indexable.length;

      const chunks = chunkTranscriptRows({
        rows: indexable,
        settings: {
          maxChunkChars: params.settings.deep.maxChunkChars,
          maxChunkMessages: params.settings.deep.maxChunkMessages,
          minChunkMessages: params.settings.deep.minChunkMessages,
        },
      });

      for (const chunk of chunks) {
        params.deep.insertChunk({
          sessionId,
          seqFrom: chunk.seqFrom,
          seqTo: chunk.seqTo,
          createdAtFromMs: chunk.createdAtFromMs,
          createdAtToMs: chunk.createdAtToMs,
          text: chunk.text,
          policyKey,
        });
      }
      run.deepChunksCreated += chunks.length;

      const emb = params.settings.embeddings;
      const provider = String(emb?.providerKind ?? '').trim();
      const modelId = String(emb?.modelId ?? '').trim();
      if (emb?.enabled === true && typeof params.embedDocuments === 'function' && provider && modelId) {
        const chunksToEmbed = params.deep.listChunksWithoutEmbeddings({
          sessionId,
          provider,
          modelId,
          limit: Math.max(1, Math.max(chunks.length, pageLimit)),
        });
        if (chunksToEmbed.length > 0) {
          try {
            const vectors = await params.embedDocuments(chunksToEmbed.map((chunk) => chunk.text), params.signal);
            params.signal?.throwIfAborted();
            if (Array.isArray(vectors) && vectors.length === chunksToEmbed.length) {
              for (let i = 0; i < chunksToEmbed.length; i += 1) {
                const chunk = chunksToEmbed[i]!;
                const vec = vectors[i]!;
                if (!(vec instanceof Float32Array) || vec.length === 0) continue;
                params.deep.upsertEmbedding({
                  sessionId: chunk.sessionId,
                  seqFrom: chunk.seqFrom,
                  seqTo: chunk.seqTo,
                  provider,
                  modelId,
                  embedding: vec,
                  updatedAtMs: nowMs,
                });
              }
            }
          } catch (error) {
            params.signal?.throwIfAborted();
            logger.debug('[memoryWorker] Missing chunk embeddings backfill failed (best-effort)', {
              sessionId,
              provider,
              modelId,
              chunkCount: chunksToEmbed.length,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (rows.length > 0) {
        params.tier1.markDeepIndexSuccess({ sessionId, seqTo: lastScannedSeq, nowMs });
      }
      if (chunks.length > 0) {
        run.sessionsIndexed += 1;
        params.tier1.recordMemorySessionIndexState({
          sessionId,
          coveragePolicyJson: JSON.stringify(params.settings.coveragePolicy ?? { type: 'full' }),
          status: 'indexed',
          lastSuccessAtMs: nowMs,
          lastAttemptAtMs: nowMs,
          lastCompletedAtMs: nowMs,
          lastObservedSeq: lastScannedSeq,
          lastScannedSeq,
          lastSemanticSeq: indexable[indexable.length - 1]!.seq,
          lastDeepIndexedSeq: lastScannedSeq,
          rawRowsFetched: rows.length,
          semanticRowsFound: indexable.length,
          semanticRowsIndexedDeep: indexable.length,
          deepChunkCount: chunks.length,
          updatedAtMs: nowMs,
        });
      }
      completedSessionIds.add(sessionId);
    } catch (error) {
      params.signal?.throwIfAborted();
      params.tier1.markDeepIndexFailure({
        sessionId,
        nowMs,
        backoffBaseMs: params.settings.deep.failureBackoffBaseMs,
        backoffMaxMs: params.settings.deep.failureBackoffMaxMs,
      });
      run.sessionsFailed += 1;
      if (params.settings.forceSnapshot === true) throw error;
    }
  }

  params.tier1.recordMemoryWorkerRun({
    runId: `deep-${nowMs}`,
    startedAtMs: nowMs,
    finishedAtMs: nowMs,
    trigger: 'sync_deep',
    indexMode: 'deep',
    sessionsConsidered: run.sessionsConsidered,
    sessionsProcessed: run.sessionsProcessed,
    sessionsIndexed: run.sessionsIndexed,
    sessionsFailed: run.sessionsFailed,
    rawRowsFetched: run.rawRowsFetched,
    semanticRowsFound: run.semanticRowsFound,
    deepChunksCreated: run.deepChunksCreated,
  });
  return completedSessionIds;
}
