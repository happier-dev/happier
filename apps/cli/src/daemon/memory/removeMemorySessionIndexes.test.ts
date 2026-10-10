import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from '../persistence/sqliteSync';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { removeMemorySessionIndexes } from './removeMemorySessionIndexes';
import { openSummaryShardIndexDb } from './summaryShardIndexDb';

function countRows(dbPath: string, sql: string, ...bindings: unknown[]): number {
  const db = openSqliteDatabaseSync(dbPath);
  try {
    const row = db.prepare(sql).get(...(bindings as never[])) as { n?: unknown } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-removal-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('removeMemorySessionIndexes', () => {
  it('clears every derived row for the removed session and retains the others', async () => {
    await withTempDir(async (dir) => {
      const tier1DbPath = join(dir, 'memory.sqlite');
      const deepDbPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1DbPath });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepDbPath });
      deep.init();

      for (const sessionId of ['gone', 'kept']) {
        tier1.insertSummaryShard({
          sessionId,
          seqFrom: 1,
          seqTo: 10,
          createdAtFromMs: 1_000,
          createdAtToMs: 2_000,
          summary: `Summary for ${sessionId} about migrations`,
          keywords: ['migrations'],
          entities: [],
          decisions: [],
        });
        tier1.markHintRunSuccess({ sessionId, seqTo: 10, nowMs: 3_000 });
        tier1.recordMemorySessionIndexState({
          sessionId,
          status: 'indexed',
          selectedByBackfillPolicy: 'all_history',
          updatedAtMs: 3_000,
        });
        deep.insertChunk({
          sessionId,
          seqFrom: 1,
          seqTo: 10,
          createdAtFromMs: 1_000,
          createdAtToMs: 2_000,
          text: `Deep chunk for ${sessionId} about migrations`,
        });
        deep.upsertEmbedding({
          sessionId,
          seqFrom: 1,
          seqTo: 10,
          provider: 'local_transformers',
          modelId: 'model',
          embedding: new Float32Array([0.1, 0.2]),
          updatedAtMs: 3_000,
        });
      }

      const removed = removeMemorySessionIndexes({ tier1, deep, sessionIds: ['gone'] });
      expect(removed).toEqual(['gone']);

      expect(tier1.search({ query: 'migrations', scope: { type: 'global' }, maxResults: 10 })
        .map((hit) => hit.sessionId)).toEqual(['kept']);
      expect(deep.search({ query: 'migrations', scope: { type: 'global' }, maxResults: 10 })
        .map((hit) => hit.sessionId)).toEqual(['kept']);

      tier1.close();
      deep.close();

      expect(countRows(tier1DbPath, 'SELECT COUNT(*) AS n FROM summary_shards WHERE sessionId = ?;', 'gone')).toBe(0);
      expect(countRows(tier1DbPath, 'SELECT COUNT(*) AS n FROM session_cursors WHERE sessionId = ?;', 'gone')).toBe(0);
      expect(countRows(tier1DbPath, 'SELECT COUNT(*) AS n FROM memory_session_index_state WHERE sessionId = ?;', 'gone')).toBe(0);
      expect(countRows(tier1DbPath, "SELECT COUNT(*) AS n FROM summary_fts WHERE summary_fts MATCH 'gone';")).toBe(0);
      expect(countRows(tier1DbPath, "SELECT COUNT(*) AS n FROM summary_fts WHERE summary_fts MATCH 'kept';")).toBe(1);
      expect(countRows(deepDbPath, 'SELECT COUNT(*) AS n FROM message_chunks WHERE sessionId = ?;', 'gone')).toBe(0);
      expect(countRows(deepDbPath, "SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'gone';")).toBe(0);
      expect(countRows(deepDbPath, "SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'kept';")).toBe(1);
      expect(countRows(deepDbPath, 'SELECT COUNT(*) AS n FROM chunk_embeddings WHERE sessionId = ?;', 'gone')).toBe(0);
      expect(countRows(deepDbPath, 'SELECT COUNT(*) AS n FROM chunk_embeddings WHERE sessionId = ?;', 'kept')).toBe(1);
    });
  });

  it('removes tier-1 state when the deep index is not open', async () => {
    await withTempDir(async (dir) => {
      const tier1 = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
      tier1.init();
      tier1.insertSummaryShard({
        sessionId: 'gone',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        summary: 'Archived transcript about migrations',
        keywords: [],
        entities: [],
        decisions: [],
      });

      expect(removeMemorySessionIndexes({ tier1, deep: null, sessionIds: ['gone', ' ', 'gone'] })).toEqual(['gone']);
      expect(tier1.search({ query: 'migrations', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      tier1.close();
    });
  });
});
