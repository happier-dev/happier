import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import type { SummaryShardIndexDbHandle } from '../summaryShardIndexDb';
import type { DeepIndexDbHandle } from './deepIndexDb';
import { chunkTranscriptRows } from './chunkTranscriptRows';
import type { OperationalMemoryEmbeddingsSettings } from '../resolveOperationalMemoryEmbeddingsSettings';

export type SyncDeepIndexSettings = Readonly<{
  enabled: boolean;
  indexMode: 'deep';
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

function isMemoryArtifactMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
  const kind = (happier as Record<string, unknown>).kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function extractTextFromContent(
  role: 'user' | 'agent',
  content: unknown,
  opts: Readonly<{ includeAssistantAcpMessage: boolean }>,
): string | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const type = (content as Record<string, unknown>).type;
  if (type === 'text') {
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
  }
  if (opts.includeAssistantAcpMessage && role === 'agent' && type === 'acp') {
    const data = (content as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const t = (data as Record<string, unknown>).type;
    if (t === 'message' || t === 'reasoning') {
      const message = (data as Record<string, unknown>).message;
      return typeof message === 'string' ? message : null;
    }
  }
  return null;
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

  for (const rawSessionId of params.sessionIds) {
    const sessionId = String(rawSessionId ?? '').trim();
    if (!sessionId) continue;

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
      continue;
    }
    const lastScannedSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : afterSeq;

    try {
      const indexable: Array<{ seq: number; createdAtMs: number; text: string; role: 'user' | 'agent' }> = [];
      for (const row of rows) {
        if (isMemoryArtifactMeta(row.meta)) continue;
        const text = extractTextFromContent(row.role, row.content, {
          includeAssistantAcpMessage: params.settings.deep.includeAssistantAcpMessage,
        });
        if (!text || text.trim().length === 0) continue;
        indexable.push({ seq: row.seq, createdAtMs: row.createdAtMs, text: text.trim(), role: row.role });
      }

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
    } catch {
      params.tier1.markDeepIndexFailure({
        sessionId,
        nowMs,
        backoffBaseMs: params.settings.deep.failureBackoffBaseMs,
        backoffMaxMs: params.settings.deep.failureBackoffMaxMs,
      });
    }
  }
}
