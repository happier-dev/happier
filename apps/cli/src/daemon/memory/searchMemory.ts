import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MemorySearchQueryV1, MemorySearchResultHitV1, MemorySearchResultV1 } from '@happier-dev/protocol';
import { createMemorySearchSnippet } from '@happier-dev/protocol/memory/memorySearchText';

import type { OperationalMemoryEmbeddingsSettings } from './resolveOperationalMemoryEmbeddingsSettings';
import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import type { MemoryDocumentSearchScope } from './syncMemoryDocuments';
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

const PageCursorSchema = z.object({
  v: z.literal(1), key: z.string(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
type PageCursor = z.infer<typeof PageCursorSchema>;

function pageKey(query: MemorySearchQueryV1, policy: unknown): string {
  return createHash('sha256').update(JSON.stringify({
    query: query.query, scope: query.scope, corpora: [...(query.corpora ?? ['sessions'])].sort(),
    eligibleSessionIds: query.eligibleSessionIds ? [...query.eligibleSessionIds].sort() : null,
    externalSource: query.externalSource ?? null,
    mode: query.mode, maxResults: query.maxResults ?? 20, minScore: query.minScore ?? 0,
    createdAfterMs: query.createdAfterMs ?? null, createdBeforeMs: query.createdBeforeMs ?? null, policy,
  })).digest('hex');
}

function readPageCursor(cursor: string | undefined, key: string): PageCursor {
  if (!cursor) return { v: 1, key, offset: 0, position: 0 };
  try {
    const value = PageCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (value.key === key) return value;
  } catch { /* Invalid or another query's cursor cannot change this query's scope. */ }
  throw Object.assign(new Error('memory_invalid_query'), { code: 'memory_invalid_query' });
}

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function searchFailure(error: unknown): MemorySearchResultV1 {
  const invalid = typeof error === 'object' && error !== null && 'code' in error && error.code === 'memory_invalid_query';
  return { v: 1, ok: false, errorCode: invalid ? 'memory_invalid_query' : 'memory_failed',
    error: error instanceof Error ? error.message : 'Memory search failed' };
}

export function searchTier1Memory(params: Readonly<{
  dbPath: string;
  query: MemorySearchQueryV1;
}>): MemorySearchResultV1 {
  const documentsRequested = params.query.corpora?.includes('documents') === true;
  if (params.query.corpora && !params.query.corpora.includes('sessions')) {
    return { v: 1, ok: true, hits: [], documents: { state: 'unavailable' } };
  }
  const maxResults = params.query.maxResults ?? 20;
  const minScore = params.query.minScore ?? 0;

  const db = openSummaryShardIndexDb({ dbPath: params.dbPath });
  try {
    const key = pageKey(params.query, { tier: 'hints', poolSize: maxResults });
    let cursor = readPageCursor(params.query.cursor, key);
    while (true) {
      const candidates = db.search({ query: params.query.query, scope: params.query.scope,
        eligibleSessionIds: params.query.eligibleSessionIds, maxResults: maxResults + 1, offset: cursor.offset,
        createdAfterMs: params.query.createdAfterMs, createdBeforeMs: params.query.createdBeforeMs });
      const qualified = candidates.slice(0, maxResults).map((hit) => ({
          sessionId: hit.sessionId,
          seqFrom: hit.seqFrom,
          seqTo: hit.seqTo,
          createdAtFromMs: hit.createdAtFromMs,
          createdAtToMs: hit.createdAtToMs,
          summary: hit.summary,
          score: hit.score,
        })).filter((hit) => hit.score >= minScore);
      const hits = qualified.slice(cursor.position, cursor.position + maxResults);
      const position = cursor.position + hits.length;
      const next = position < qualified.length ? { ...cursor, position }
        : candidates.length > maxResults ? { ...cursor, offset: cursor.offset + maxResults, position: 0 } : null;
      if (hits.length || !next) return { v: 1, ok: true, hits, hasMore: next !== null,
        ...(next ? { nextCursor: encodePageCursor(next) } : {}),
        ...(documentsRequested ? { documents: { state: 'unavailable' as const } } : {}) };
      cursor = next;
    }
  } catch (e: unknown) {
    return searchFailure(e);
  } finally {
    db.close();
  }
}

export async function searchTier2Memory(params: Readonly<{
  dbPath: string;
  /** Hinted Happier Sessions stay on their chosen owner when native deep rows are also requested. */
  sessionSummaryDbPath?: string;
  externalAgentIds?: readonly string[];
  query: MemorySearchQueryV1;
  previewChars: number;
  candidateLimit?: number;
  embeddings?: OperationalMemoryEmbeddingsSettings | null;
  embedQuery?: (queryText: string, signal?: AbortSignal) => Promise<Float32Array>;
  signal?: AbortSignal;
  resolveDocuments?: (scope: MemorySearchQueryV1['scope'], signal?: AbortSignal) => Promise<MemoryDocumentSearchScope>;
}>): Promise<MemorySearchResultV1> {
  params.signal?.throwIfAborted();
  const documentsRequested = params.query.corpora?.includes('documents') === true;
  const sessionsRequested = !params.query.corpora || params.query.corpora.includes('sessions');
  const externalRequested = params.query.corpora?.includes('external_transcripts') === true;
  const maxResults = params.query.maxResults ?? 20;
  const minScore = params.query.minScore ?? 0;
  const previewChars = params.previewChars;
  const embeddings = params.embeddings;
  const candidateLimitRaw = params.candidateLimit ?? maxResults;
  const candidateLimit = Math.max(maxResults, Math.max(1, Math.floor(candidateLimitRaw)));

  const db = openDeepIndexDb({ dbPath: params.dbPath });
  let summaryDb: ReturnType<typeof openSummaryShardIndexDb> | null = null;
  try {
    summaryDb = params.sessionSummaryDbPath && sessionsRequested
      ? openSummaryShardIndexDb({ dbPath: params.sessionSummaryDbPath }) : null;
    const key = pageKey(params.query, { tier: 'deep', poolSize: candidateLimit,
      hintedSessions: summaryDb !== null, externalAgentIds: params.externalAgentIds ? [...params.externalAgentIds].sort() : null, embeddings });
    let cursor = readPageCursor(params.query.cursor, key);
    while (true) {
      params.signal?.throwIfAborted();
      const candidates = (sessionsRequested && !summaryDb) || externalRequested ? db.search({
        query: params.query.query,
        scope: params.query.scope,
        eligibleSessionIds: params.query.eligibleSessionIds,
        maxResults: candidateLimit + 1,
        offset: cursor.offset,
        createdAfterMs: params.query.createdAfterMs,
        createdBeforeMs: params.query.createdBeforeMs,
        includeSessions: sessionsRequested && !summaryDb,
        includeExternal: externalRequested,
        externalAgentIds: params.externalAgentIds,
        externalSource: params.query.externalSource,
      }) : [];
      const hintedCandidates = summaryDb ? summaryDb.search({ query: params.query.query, scope: params.query.scope,
        eligibleSessionIds: params.query.eligibleSessionIds, maxResults: candidateLimit + 1, offset: cursor.offset,
        createdAfterMs: params.query.createdAfterMs, createdBeforeMs: params.query.createdBeforeMs }) : [];

      let ranked = candidates.slice(0, candidateLimit).map((hit) => ({
        ...hit,
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
        const provider = String(embeddings.providerKind ?? '').trim();
        const modelId = String(embeddings.modelId ?? '').trim();
        if (provider && modelId) {
          try {
            params.signal?.throwIfAborted();
            const queryEmbedding = await params.embedQuery(params.query.query, params.signal);
            params.signal?.throwIfAborted();
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
              weights: {
                wFts: embeddings.blend.ftsWeight,
                wEmb: embeddings.blend.embeddingWeight,
              },
            });

            const scoreByKey = new Map<string, number>();
            for (const row of reranked) scoreByKey.set(row.id, row.finalScore);
            ranked = ranked
              .map((hit) => ({ ...hit, finalScore: scoreByKey.get(hit.key) ?? hit.baseScore }))
              .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
          } catch {
            params.signal?.throwIfAborted();
            // Best-effort: fall back to base rank ordering.
          }
        }
      }

      // Qualify documents after asynchronous reranking, immediately before disclosure.
      const documentScope = documentsRequested && params.resolveDocuments
        ? await params.resolveDocuments(params.query.scope, params.signal)
        : { state: 'unavailable' as const, eligibleDocuments: [] };
      params.signal?.throwIfAborted();
      if (documentScope.state === 'ready') documentScope.assertCurrent();
      const documentHits = documentScope.state === 'ready' ? db.searchDocuments({
        query: params.query.query, eligibleDocuments: documentScope.eligibleDocuments, maxResults,
      }).map(hit => ({ type: 'artifact' as const, ref: { kind: 'doc' as const, ...hit.ref }, revision: hit.revision,
        ...(hit.factId ? { factId: hit.factId } : {}), location: hit.location,
        summary: trimToMaxChars(hit.text, previewChars) || hit.text, score: hit.score })) : [];
      const conversationHits: MemorySearchResultHitV1[] = ranked.map((hit) => {
        const common = { createdAtFromMs: hit.createdAtFromMs, createdAtToMs: hit.createdAtToMs,
          summary: createMemorySearchSnippet(hit.text, hit.matchedQuery ?? params.query.query, previewChars),
          score: hit.finalScore ?? hit.baseScore };
        if (hit.source?.type === 'external_transcript') {
          if (!hit.sourceItemId) throw new Error('memory_external_item_identity_missing');
          return { type: 'external_transcript' as const, source: hit.source, sourceItemId: hit.sourceItemId,
            ...(hit.sourceCursor ? { cursor: hit.sourceCursor } : {}), ...common };
        }
        return { sessionId: hit.sessionId, seqFrom: hit.seqFrom, seqTo: hit.seqTo, ...common };
      });
      conversationHits.push(...hintedCandidates.slice(0, candidateLimit).map(hit => ({
        sessionId: hit.sessionId, seqFrom: hit.seqFrom, seqTo: hit.seqTo,
        createdAtFromMs: hit.createdAtFromMs, createdAtToMs: hit.createdAtToMs,
        summary: createMemorySearchSnippet(hit.summary, hit.matchedQuery ?? params.query.query, previewChars), score: hit.score,
      })));
      // Documents retain their existing one-query top-result contract. Conversation
      // cursors traverse fixed candidate windows so reranking cannot repeat a hit.
      const qualified = [...conversationHits, ...(cursor.offset === 0 ? documentHits : [])]
        .sort(summaryDb ? (a, b) => (
          ('createdAtToMs' in b ? b.createdAtToMs : 0) - ('createdAtToMs' in a ? a.createdAtToMs : 0)
        ) : (a, b) => b.score - a.score)
        .filter(hit => hit.score >= minScore);
      const hits = qualified.slice(cursor.position, cursor.position + maxResults);
      const position = cursor.position + hits.length;
      const next = position < qualified.length ? { ...cursor, position }
        : candidates.length > candidateLimit || hintedCandidates.length > candidateLimit
          ? { ...cursor, offset: cursor.offset + candidateLimit, position: 0 } : null;
      if (!hits.length && next) { cursor = next; continue; }
      if (documentScope.state === 'ready') documentScope.assertCurrent();
      return {
        v: 1,
        ok: true,
        ...(documentsRequested ? { documents: { state: documentScope.state } } : {}),
        hits, hasMore: next !== null,
        ...(next ? { nextCursor: encodePageCursor(next) } : {}),
      };
    }
  } catch (e: unknown) {
    params.signal?.throwIfAborted();
    return searchFailure(e);
  } finally {
    summaryDb?.close();
    db.close();
  }
}
