import type { MemorySearchQueryV1, MemorySearchResultV1 } from '@happier-dev/protocol';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { rerankHitsWithEmbeddings } from './deepIndex/embeddings/rerankHitsWithEmbeddings';

function trimToMaxChars(text: string, maxChars: number): string {
  const max = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 0;
  const value = String(text ?? '');
  if (max <= 0) return '';
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function deepHitKey(hit: Readonly<{ sessionId: string; seqFrom: number; seqTo: number }>): string {
  return `${hit.sessionId}:${hit.seqFrom}-${hit.seqTo}`;
}

export function searchTier1Memory(params: Readonly<{
  dbPath: string;
  query: MemorySearchQueryV1;
}>): MemorySearchResultV1 {
  const maxResults = params.query.maxResults ?? 20;
  const minScore = params.query.minScore ?? 0;

  const db = openSummaryShardIndexDb({ dbPath: params.dbPath });
  try {
    const hits = db.search({
      query: params.query.query,
      scope: params.query.scope,
      maxResults,
    });
    return {
      v: 1,
      ok: true,
      hits: hits
        .map((hit) => ({
          sessionId: hit.sessionId,
          seqFrom: hit.seqFrom,
          seqTo: hit.seqTo,
          createdAtFromMs: hit.createdAtFromMs,
          createdAtToMs: hit.createdAtToMs,
          summary: hit.summary,
          score: hit.score,
        }))
        .filter((hit) => hit.score >= minScore),
    };
  } catch (e: any) {
    return {
      v: 1,
      ok: false,
      errorCode: 'memory_failed',
      error: e instanceof Error ? e.message : 'Memory search failed',
    };
  } finally {
    db.close();
  }
}

export async function searchTier2Memory(params: Readonly<{
  dbPath: string;
  query: MemorySearchQueryV1;
  previewChars: number;
  candidateLimit?: number;
  embeddings?: Readonly<{
    enabled: boolean;
    provider: string;
    modelId: string;
    wFts: number;
    wEmb: number;
  }>;
  embedQuery?: (queryText: string) => Promise<Float32Array>;
}>): Promise<MemorySearchResultV1> {
  const maxResults = params.query.maxResults ?? 20;
  const minScore = params.query.minScore ?? 0;
  const previewChars = params.previewChars;
  const embeddings = params.embeddings;
  const candidateLimitRaw = params.candidateLimit ?? maxResults;
  const candidateLimit = Math.max(maxResults, Math.max(1, Math.min(1000, Math.floor(candidateLimitRaw))));

  const db = openDeepIndexDb({ dbPath: params.dbPath });
  try {
    const candidates = db.search({
      query: params.query.query,
      scope: params.query.scope,
      maxResults: candidateLimit,
    });

    let ranked = candidates.map((hit) => ({
      key: deepHitKey(hit),
      sessionId: hit.sessionId,
      seqFrom: hit.seqFrom,
      seqTo: hit.seqTo,
      createdAtFromMs: hit.createdAtFromMs,
      createdAtToMs: hit.createdAtToMs,
      text: hit.text,
      baseScore: hit.score,
      finalScore: undefined as number | undefined,
    }));

    if (embeddings?.enabled === true && typeof params.embedQuery === 'function' && ranked.length > 0) {
      const provider = String(embeddings.provider ?? '').trim();
      const modelId = String(embeddings.modelId ?? '').trim();
      if (provider && modelId) {
        try {
          const queryEmbedding = await params.embedQuery(params.query.query);
          const embeddingMap = db.loadEmbeddings({
            provider,
            modelId,
            keys: ranked.map((hit) => ({
              sessionId: hit.sessionId,
              seqFrom: hit.seqFrom,
              seqTo: hit.seqTo,
            })),
          });

          const reranked = rerankHitsWithEmbeddings({
            hits: ranked.map((hit) => ({
              id: hit.key,
              baseScore: hit.baseScore,
              embedding: embeddingMap.get(hit.key) ?? null,
            })),
            queryEmbedding,
            weights: { wFts: embeddings.wFts, wEmb: embeddings.wEmb },
          });

          const scoreByKey = new Map<string, number>();
          for (const row of reranked) scoreByKey.set(row.id, row.finalScore);
          ranked = ranked
            .map((hit) => ({ ...hit, finalScore: scoreByKey.get(hit.key) ?? hit.baseScore }))
            .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
        } catch {
          // Best-effort: fall back to base rank ordering.
        }
      }
    }

    return {
      v: 1,
      ok: true,
      hits: ranked
        .map((hit) => ({
          sessionId: hit.sessionId,
          seqFrom: hit.seqFrom,
          seqTo: hit.seqTo,
          createdAtFromMs: hit.createdAtFromMs,
          createdAtToMs: hit.createdAtToMs,
          summary: trimToMaxChars(hit.text, previewChars) || hit.text,
          score: hit.finalScore ?? hit.baseScore,
        }))
        .filter((hit) => hit.score >= minScore),
    };
  } catch (e: any) {
    return {
      v: 1,
      ok: false,
      errorCode: 'memory_failed',
      error: e instanceof Error ? e.message : 'Memory search failed',
    };
  } finally {
    db.close();
  }
}
