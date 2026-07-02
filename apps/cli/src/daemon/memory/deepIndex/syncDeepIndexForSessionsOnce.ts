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

export type SyncDeepIndexSettings = Readonly<{
  enabled: boolean;
  indexMode: 'deep';
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
  fetchDecryptedTranscriptPageAfterSeq: (args: Readonly<{ sessionId: string; afterSeq: number; limit: number }>) => Promise<DecryptedTranscriptRow[]>;
  embedDocuments?: (texts: readonly string[]) => Promise<Float32Array[]>;
}>): Promise<void> {
  if (!params.settings.enabled) return;
  if (params.settings.indexMode !== 'deep') return;
  const nowMs = Math.max(0, Math.trunc(params.now()));
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
    const sessionId = String(rawSessionId ?? '').trim();
    if (!sessionId) continue;
    run.sessionsConsidered += 1;

    const cursors = params.tier1.getSessionCursors({ sessionId, nowMs });
    if (cursors.nextDeepEligibleAtMs > nowMs) continue;

    const afterSeq = Math.max(0, Math.trunc(cursors.lastDeepIndexedSeq));
    let rows: DecryptedTranscriptRow[] = [];
    try {
      rows = await params.fetchDecryptedTranscriptPageAfterSeq({ sessionId, afterSeq, limit: pageLimit });
    } catch {
      params.tier1.markDeepIndexFailure({
        sessionId,
        nowMs,
        backoffBaseMs: params.settings.deep.failureBackoffBaseMs,
        backoffMaxMs: params.settings.deep.failureBackoffMaxMs,
      });
      run.sessionsFailed += 1;
      continue;
    }
    run.rawRowsFetched += rows.length;
    if (rows.length > 0) run.sessionsProcessed += 1;
    const lastScannedSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : afterSeq;

    try {
      const indexable = rows
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
            const vectors = await params.embedDocuments(chunksToEmbed.map((chunk) => chunk.text));
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
    } catch {
      params.tier1.markDeepIndexFailure({
        sessionId,
        nowMs,
        backoffBaseMs: params.settings.deep.failureBackoffBaseMs,
        backoffMaxMs: params.settings.deep.failureBackoffMaxMs,
      });
      run.sessionsFailed += 1;
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
}
