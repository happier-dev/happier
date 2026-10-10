import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from '../persistence/sqliteSync';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { openSummaryShardIndexDb } from './summaryShardIndexDb';

const REPRESENTATIVE_ROW_COUNT = 25_000;

async function fileBytes(path: string): Promise<number> {
  const entries = await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async (candidate) => {
    try { return await stat(candidate); } catch { return null; }
  }));
  return entries.reduce((total, entry) => total + (entry?.size ?? 0), 0);
}

describe('daemon memory Unicode migration performance', () => {
  it.skipIf(process.env.HAPPIER_RUN_MEMORY_MIGRATION_PERFORMANCE !== '1')('measures retained-source term rebuilds for 25,000 rows per tier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-memory-unicode-performance-'));
    try {
      const summaryPath = join(root, 'memory.sqlite');
      const summaryLegacy = openSqliteDatabaseSync(summaryPath);
      // Pre-FTS retained-source schema, matching summaryShardIndexDb's migration
      // fixture; opening the current owner first would already drop postings.
      summaryLegacy.exec(`
        CREATE TABLE summary_shards (
          shardId INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT NOT NULL,
          seqFrom INTEGER NOT NULL,
          seqTo INTEGER NOT NULL,
          createdAtFromMs INTEGER NOT NULL,
          createdAtToMs INTEGER NOT NULL,
          summary TEXT NOT NULL,
          keywordsText TEXT NOT NULL,
          entitiesText TEXT NOT NULL,
          decisionsText TEXT NOT NULL,
          UNIQUE (sessionId, seqFrom, seqTo)
        );
        CREATE TABLE summary_terms (
          term TEXT NOT NULL,
          shardId INTEGER NOT NULL,
          PRIMARY KEY (term, shardId),
          FOREIGN KEY (shardId) REFERENCES summary_shards(shardId) ON DELETE CASCADE
        );
      `);
      const insertSummary = summaryLegacy.prepare(`
        INSERT INTO summary_shards (
          sessionId, seqFrom, seqTo, createdAtFromMs, createdAtToMs,
          summary, keywordsText, entitiesText, decisionsText
        ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '');
      `);
      const insertSummaryTerm = summaryLegacy.prepare(`INSERT INTO summary_terms (term, shardId) VALUES ('legacyascii', ?);`);
      summaryLegacy.exec('BEGIN IMMEDIATE');
      for (let index = 0; index < REPRESENTATIVE_ROW_COUNT; index += 1) {
        const result = insertSummary.run(
          `s-${index % 100}`,
          index,
          index,
          index,
          index,
          `Architecture review ${index}: Unicode search 搜索 поиск and identifier session_handoff.`,
          'legacyascii',
        ) as { lastInsertRowid?: number | bigint };
        insertSummaryTerm.run(Number(result.lastInsertRowid));
      }
      summaryLegacy.exec('PRAGMA user_version=3; COMMIT;');
      summaryLegacy.close();

      const summaryStartedAt = performance.now();
      const summary = openSummaryShardIndexDb({ dbPath: summaryPath });
      const summaryElapsedMs = performance.now() - summaryStartedAt;
      expect(summary.getSummaryIndexStats().lightShardCount).toBe(REPRESENTATIVE_ROW_COUNT);
      expect(summary.search({ query: '搜索', scope: { type: 'global' }, maxResults: 1 })).toHaveLength(1);
      summary.close();

      const deepPath = join(root, 'deep.sqlite');
      const deepLegacy = openSqliteDatabaseSync(deepPath);
      // Same predecessor chunk/postings schema as deepIndexDb's upgrade test.
      deepLegacy.exec(`
        CREATE TABLE message_chunks (
          chunkId INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT NOT NULL,
          seqFrom INTEGER NOT NULL,
          seqTo INTEGER NOT NULL,
          createdAtFromMs INTEGER NOT NULL,
          createdAtToMs INTEGER NOT NULL,
          text TEXT NOT NULL,
          UNIQUE (sessionId, seqFrom, seqTo)
        );
        CREATE TABLE chunk_terms (
          term TEXT NOT NULL,
          chunkId INTEGER NOT NULL,
          PRIMARY KEY (term, chunkId),
          FOREIGN KEY (chunkId) REFERENCES message_chunks(chunkId) ON DELETE CASCADE
        );
      `);
      const insertChunk = deepLegacy.prepare(`
        INSERT INTO message_chunks (
          sessionId, seqFrom, seqTo, createdAtFromMs, createdAtToMs, text
        ) VALUES (?, ?, ?, ?, ?, ?);
      `);
      const insertChunkTerm = deepLegacy.prepare(`INSERT INTO chunk_terms (term, chunkId) VALUES ('legacyascii', ?);`);
      deepLegacy.exec('BEGIN IMMEDIATE');
      for (let index = 0; index < REPRESENTATIVE_ROW_COUNT; index += 1) {
        const result = insertChunk.run(
          `s-${index % 100}`,
          index,
          index,
          index,
          index,
          `Transcript chunk ${index}: Unicode search 搜索 поиск and identifier session_handoff.`,
        ) as { lastInsertRowid?: number | bigint };
        insertChunkTerm.run(Number(result.lastInsertRowid));
      }
      deepLegacy.exec('PRAGMA user_version=1; COMMIT;');
      deepLegacy.close();

      const deepStartedAt = performance.now();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      const deepElapsedMs = performance.now() - deepStartedAt;
      expect(deep.getDeepIndexStats().deepChunkCount).toBe(REPRESENTATIVE_ROW_COUNT);
      expect(deep.search({ query: '搜索', scope: { type: 'global' }, maxResults: 1 })).toHaveLength(1);
      deep.close();

      console.info(JSON.stringify({
        benchmark: 'daemon-memory-unicode-retained-source-migration',
        rowsPerTier: REPRESENTATIVE_ROW_COUNT,
        summaryElapsedMs: Math.round(summaryElapsedMs),
        summaryDatabaseBytes: await fileBytes(summaryPath),
        deepElapsedMs: Math.round(deepElapsedMs),
        deepDatabaseBytes: await fileBytes(deepPath),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
