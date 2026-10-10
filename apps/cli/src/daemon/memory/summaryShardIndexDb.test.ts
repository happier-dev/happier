import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

import { openSqliteDatabaseSync } from '../persistence/sqliteSync';
import { openSummaryShardIndexDb } from './summaryShardIndexDb';

function countRows(dbPath: string, table: string): number {
  const db = openSqliteDatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as any;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

describe('summaryShardIndexDb', () => {
  it('repairs typos only from postings visible to the complete search scope', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-summary-scoped-typos-'));
    try {
      const db = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
      const insert = (sessionId: string, seq: number, summary: string, time: number) => db.insertSummaryShard({ sessionId, summary, entities: [], keywords: [], decisions: [], seqFrom: seq, seqTo: seq, createdAtFromMs: time, createdAtToMs: time });
      insert('target', 1, 'quasar planet', 100);
      for (let seq = 1; seq <= 5; seq += 1) insert('excluded', seq, 'quasray planes', 200);
      for (const query of ['quasra', 'planer']) {
        expect.soft(db.search({ query, scope: { type: 'session', sessionId: 'target' }, maxResults: 10 }).map((hit) => hit.sessionId), query).toEqual(['target']);
        expect.soft(db.search({ query, scope: { type: 'global' }, eligibleSessionIds: ['target', ...Array.from({ length: 1000 }, (_, i) => `absent-${i}`)], maxResults: 10 }).map((hit) => hit.sessionId), query).toEqual(['target']);
        expect.soft(db.search({ query, scope: { type: 'global' }, createdBeforeMs: 150, maxResults: 10 }).map((hit) => hit.sessionId), query).toEqual(['target']);
      }
      insert('target', 2, 'planes', 100);
      insert('target', 3, 'planet', 100);
      insert('target', 4, 'planet', 100);
      expect(db.search({ query: 'planer', scope: { type: 'session', sessionId: 'target' }, maxResults: 10 }).map((hit) => hit.seqFrom).sort((a, b) => a - b)).toEqual([1, 3, 4]);
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('uses full query matching with weighted identifiers, prefixes, typo repair and paging', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-summary-retrieval-'));
    try {
      const db = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
      for (const [sessionId, summary, entities, time] of [
        ['body', 'the quasar session_handoff', [], 200],
        ['identifier', 'the quasar', ['session_handoff'], 100],
        ['common', 'the ordinary conversation', [], 300],
      ] as const) {
        db.insertSummaryShard({ sessionId, summary, entities, keywords: [], decisions: [], seqFrom: 1, seqTo: 1, createdAtFromMs: time, createdAtToMs: time });
      }
      expect(db.search({ query: 'the quasar', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(2);
      for (const query of ['session_handoff', 'session handoff', 'session_hand', 'sesion_handoff']) {
        expect(db.search({ query, scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId), query).toEqual(['identifier', 'body']);
      }
      expect(db.search({ query: 'quasar', scope: { type: 'global' }, maxResults: 1, offset: 1, createdBeforeMs: 150 })).toEqual([]);
      db.insertSummaryShard({ sessionId: 'identifier', summary: 'replacement', entities: [], keywords: [], decisions: [], seqFrom: 1, seqTo: 1, createdAtFromMs: 100, createdAtToMs: 100 });
      expect(db.search({ query: 'handoff', scope: { type: 'session', sessionId: 'identifier' }, maxResults: 10 })).toEqual([]);
      db.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.runIf(process.platform !== 'win32')('rejects a symbolic-link SQLite sidecar before opening retained plaintext', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-sidecar-'));
    try {
      await chmod(dir, 0o700);
      const dbPath = join(dir, 'memory.sqlite');
      const seed = openSqliteDatabaseSync(dbPath);
      seed.close();
      const outsidePath = join(dir, 'outside');
      await writeFile(outsidePath, 'unchanged');
      await symlink(outsidePath, `${dbPath}-wal`);

      expect(() => openSummaryShardIndexDb({ dbPath }))
        .toThrow('Protected local state must not be a symbolic link');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('protects the SQLite main, WAL, and SHM files', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-protection-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.insertSummaryShard({
        sessionId: 'private-session',
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        summary: 'private retained summary',
        keywords: [],
        entities: [],
        decisions: [],
      });

      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('indexes summary shards and returns session/seq windows via FTS search', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      db.insertSummaryShard({
        sessionId: 'sess_1',
        seqFrom: 1,
        seqTo: 10,
        createdAtFromMs: 1000,
        createdAtToMs: 2000,
        summary: 'We discussed OpenClaw deep memory search and indexing.',
        keywords: ['openclaw', 'memory', 'search'],
        entities: ['OpenClaw'],
        decisions: ['Implement tier-1 summaries'],
      });

      db.insertSummaryShard({
        sessionId: 'sess_2',
        seqFrom: 5,
        seqTo: 8,
        createdAtFromMs: 3000,
        createdAtToMs: 3500,
        summary: 'Unrelated conversation about groceries.',
        keywords: ['groceries'],
        entities: [],
        decisions: [],
      });

      const hits = db.search({
        query: 'OpenClaw',
        scope: { type: 'global' },
        maxResults: 10,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.sessionId).toBe('sess_1');
      expect(hits[0]?.seqFrom).toBe(1);
      expect(hits[0]?.seqTo).toBe(10);

      const scoped = db.search({
        query: 'groceries',
        scope: { type: 'session', sessionId: 'sess_1' },
        maxResults: 10,
      });
      expect(scoped).toEqual([]);

      const scoped2 = db.search({
        query: 'groceries',
        scope: { type: 'session', sessionId: 'sess_2' },
        maxResults: 10,
      });
      expect(scoped2.length).toBe(1);
      expect(scoped2[0]?.sessionId).toBe('sess_2');

      expect(db.getLatestShardSeqTo({ sessionId: 'sess_1' })).toBe(10);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for empty/whitespace queries', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-empty-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();
      expect(db.search({ query: '   ', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies Session eligibility before the result limit', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-eligibility-'));
    try {
      const db = openSummaryShardIndexDb({ dbPath: join(dir, 'memory.sqlite') });
      db.init();
      for (let index = 0; index < 3; index += 1) {
        db.insertSummaryShard({
          sessionId: `active-${index}`,
          seqFrom: 1,
          seqTo: 1,
          createdAtFromMs: 100 + index,
          createdAtToMs: 100 + index,
          summary: 'shared eligibility term',
          keywords: [],
          entities: [],
          decisions: [],
        });
      }
      db.insertSummaryShard({
        sessionId: 'archived-target',
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        summary: 'shared eligibility term',
        keywords: [],
        entities: [],
        decisions: [],
      });

      expect(db.search({
        query: 'eligibility',
        scope: { type: 'global' },
        eligibleSessionIds: ['archived-target'],
        maxResults: 2,
      })).toEqual([expect.objectContaining({ sessionId: 'archived-target' })]);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('seeds and reads per-session cursor state', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-cursors-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      const seeded = db.trySeedSessionCursorsIfMissing({
        sessionId: 'sess_1',
        nowMs: 1000,
        lastHintedSeq: 123,
        lastDeepIndexedSeq: 77,
      });
      expect(seeded).toBe(true);

      const cursors = db.getSessionCursors({ sessionId: 'sess_1', nowMs: 2000 });
      expect(cursors.lastHintedSeq).toBe(123);
      expect(cursors.lastDeepIndexedSeq).toBe(77);
      expect(cursors.consecutiveDeepFailures).toBe(0);

      const seededAgain = db.trySeedSessionCursorsIfMissing({
        sessionId: 'sess_1',
        nowMs: 3000,
        lastHintedSeq: 999,
        lastDeepIndexedSeq: 999,
      });
      expect(seededAgain).toBe(false);

      const cursorsAfter = db.getSessionCursors({ sessionId: 'sess_1', nowMs: 4000 });
      expect(cursorsAfter.lastHintedSeq).toBe(123);
      expect(cursorsAfter.lastDeepIndexedSeq).toBe(77);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tracks deep index backoff and success', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-deep-backoff-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      db.markDeepIndexFailure({
        sessionId: 'sess_1',
        nowMs: 10_000,
        backoffBaseMs: 1000,
        backoffMaxMs: 5_000,
      });

      const afterFailure = db.getSessionCursors({ sessionId: 'sess_1', nowMs: 10_000 });
      expect(afterFailure.consecutiveDeepFailures).toBe(1);
      expect(afterFailure.nextDeepEligibleAtMs).toBe(11_000);

      db.markDeepIndexSuccess({ sessionId: 'sess_1', seqTo: 50, nowMs: 12_000 });
      const afterSuccess = db.getSessionCursors({ sessionId: 'sess_1', nowMs: 12_000 });
      expect(afterSuccess.lastDeepIndexedSeq).toBe(50);
      expect(afterSuccess.consecutiveDeepFailures).toBe(0);
      expect(afterSuccess.nextDeepEligibleAtMs).toBe(0);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evicts oldest shards globally and cascades term rows', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-evict-global-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      db.insertSummaryShard({
        sessionId: 'sess_1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1000,
        createdAtToMs: 1000,
        summary: 'oldestuniq unique',
        keywords: [],
        entities: [],
        decisions: [],
      });
      db.insertSummaryShard({
        sessionId: 'sess_1',
        seqFrom: 3,
        seqTo: 4,
        createdAtFromMs: 2000,
        createdAtToMs: 2000,
        summary: 'newestuniq unique',
        keywords: [],
        entities: [],
        decisions: [],
      });

      expect(db.search({ query: 'oldestuniq', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);
      expect(db.search({ query: 'newestuniq', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);

      const deleted = db.deleteOldestSummaryShards({ limit: 1 });
      expect(deleted).toBe(1);

      expect(db.search({ query: 'oldestuniq', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(db.search({ query: 'newestuniq', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);

      db.checkpointAndVacuum();

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches non-ASCII summaries instead of returning an empty result', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-unicode-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      db.insertSummaryShard({
        sessionId: 'sess_unicode',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1000,
        createdAtToMs: 1000,
        summary: 'Обсудили メモリ検索機能 и Καλημέρα déjà vu',
        keywords: ['поиск'],
        entities: [],
        decisions: [],
      });

      for (const query of ['Обсудили', 'поиск', '検索', 'Καλημέρα', 'déjà']) {
        const hits = db.search({ query, scope: { type: 'global' }, maxResults: 10 });
        expect(hits.map((hit) => hit.sessionId), query).toEqual(['sess_unicode']);
      }

      expect(db.search({ query: 'groceries', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds terms from the released schema-v2 source text while preserving shards and cursors', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-migrate-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');

      // Provenance-pinned to cli-v0.2.1 and
      // cli-v0.2.2-preview.1775586717.26498: both released this schema-v2
      // shape with ASCII-only term rows.
      const legacy = openSqliteDatabaseSync(dbPath);
      legacy.exec(`PRAGMA foreign_keys=ON;`);
      legacy.exec(`
        CREATE TABLE session_cursors (
          sessionId TEXT PRIMARY KEY,
          lastObservedSeq INTEGER NOT NULL DEFAULT 0,
          lastHintedSeq INTEGER NOT NULL DEFAULT 0,
          lastDeepIndexedSeq INTEGER NOT NULL DEFAULT 0,
          lastHintRunAtMs INTEGER NOT NULL DEFAULT 0,
          hintRunWindowStartMs INTEGER NOT NULL DEFAULT 0,
          hintRunWindowCount INTEGER NOT NULL DEFAULT 0,
          lastHintErrorAtMs INTEGER,
          lastDeepErrorAtMs INTEGER,
          consecutiveHintFailures INTEGER NOT NULL DEFAULT 0,
          consecutiveDeepFailures INTEGER NOT NULL DEFAULT 0,
          nextHintEligibleAtMs INTEGER NOT NULL DEFAULT 0,
          nextDeepEligibleAtMs INTEGER NOT NULL DEFAULT 0,
          updatedAtMs INTEGER NOT NULL DEFAULT 0
        );
      `);
      legacy.exec(`
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
      `);
      legacy.exec(`
        CREATE TABLE summary_terms (
          term TEXT NOT NULL,
          shardId INTEGER NOT NULL,
          PRIMARY KEY (term, shardId),
          FOREIGN KEY (shardId) REFERENCES summary_shards(shardId) ON DELETE CASCADE
        );
      `);
      legacy
        .prepare(`
          INSERT INTO summary_shards (
            shardId, sessionId, seqFrom, seqTo, createdAtFromMs, createdAtToMs,
            summary, keywordsText, entitiesText, decisionsText
          ) VALUES (1, 'sess_legacy', 1, 4, 1000, 2000, ?, '', '', '');
        `)
        .run('Обсудили メモリ検索 and legacyascii');
      legacy.prepare(`INSERT INTO summary_terms (term, shardId) VALUES ('legacyascii', 1);`).run();
      legacy
        .prepare(`
          INSERT INTO session_cursors (sessionId, lastObservedSeq, lastHintedSeq, lastDeepIndexedSeq, updatedAtMs)
          VALUES ('sess_legacy', 9, 7, 5, 1234);
        `)
        .run();
      legacy.exec('PRAGMA user_version=2');
      legacy.close();

      expect(
        openSqliteDatabaseSync(dbPath).prepare('PRAGMA user_version').get(),
      ).toMatchObject({ user_version: 2 });

      const originalAll = StatementSync.prototype.all;
      const allSpy = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...args) {
        if (/FROM\s+summary_shards/i.test(this.sourceSQL) && !/\bLIMIT\b/i.test(this.sourceSQL)) {
          throw new Error('summary migration selected the complete retained corpus');
        }
        return Reflect.apply(originalAll, this, args);
      });
      let db: ReturnType<typeof openSummaryShardIndexDb>;
      try {
        db = openSummaryShardIndexDb({ dbPath });
      } finally {
        allSpy.mockRestore();
      }
      db.init();

      // Retained source text is re-tokenized, so previously unsearchable
      // non-ASCII content becomes searchable without a server refetch.
      expect(
        db.search({ query: 'Обсудили', scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId),
      ).toEqual(['sess_legacy']);
      expect(
        db.search({ query: '検索', scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId),
      ).toEqual(['sess_legacy']);
      expect(
        db.search({ query: 'legacyascii', scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId),
      ).toEqual(['sess_legacy']);

      // The shard row and the progress cursors survive the term rebuild.
      expect(db.getLatestShardSeqTo({ sessionId: 'sess_legacy' })).toBe(4);
      expect(db.getSessionCursors({ sessionId: 'sess_legacy', nowMs: 5000 })).toMatchObject({
        lastObservedSeq: 9,
        lastHintedSeq: 7,
        lastDeepIndexedSeq: 5,
      });

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('upgrades the deployed preview schema-v3 queue, cursor, and shard state in place', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-preview-v3-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');

      // Provenance-pinned to the published 0.2.11-preview.2 package and its
      // cli-v0.2.11-preview.2 tag at 98ea8fb76733b1dd785d38c31360179cafa84824. That preview wrote
      // summary schema v3: the v2 shard/cursor tables plus these queue tables,
      // with ASCII-only term rows.
      const preview = openSqliteDatabaseSync(dbPath);
      preview.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA foreign_keys=ON;
        PRAGMA auto_vacuum=INCREMENTAL;
        CREATE TABLE session_cursors (
          sessionId TEXT PRIMARY KEY,
          lastObservedSeq INTEGER NOT NULL DEFAULT 0,
          lastHintedSeq INTEGER NOT NULL DEFAULT 0,
          lastDeepIndexedSeq INTEGER NOT NULL DEFAULT 0,
          lastHintRunAtMs INTEGER NOT NULL DEFAULT 0,
          hintRunWindowStartMs INTEGER NOT NULL DEFAULT 0,
          hintRunWindowCount INTEGER NOT NULL DEFAULT 0,
          lastHintErrorAtMs INTEGER,
          lastDeepErrorAtMs INTEGER,
          consecutiveHintFailures INTEGER NOT NULL DEFAULT 0,
          consecutiveDeepFailures INTEGER NOT NULL DEFAULT 0,
          nextHintEligibleAtMs INTEGER NOT NULL DEFAULT 0,
          nextDeepEligibleAtMs INTEGER NOT NULL DEFAULT 0,
          updatedAtMs INTEGER NOT NULL DEFAULT 0
        );
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
        CREATE INDEX summary_shards_by_session_seqTo ON summary_shards(sessionId, seqTo);
        CREATE TABLE summary_terms (
          term TEXT NOT NULL,
          shardId INTEGER NOT NULL,
          PRIMARY KEY (term, shardId),
          FOREIGN KEY (shardId) REFERENCES summary_shards(shardId) ON DELETE CASCADE
        );
        CREATE INDEX summary_terms_term_idx ON summary_terms(term);
        CREATE TABLE memory_session_index_state (
          sessionId TEXT PRIMARY KEY,
          selectedByBackfillPolicy TEXT,
          coveragePolicyJson TEXT NOT NULL,
          status TEXT NOT NULL,
          queuedReason TEXT,
          lastQueuedAtMs INTEGER,
          lastStartedAtMs INTEGER,
          lastSuccessAtMs INTEGER,
          lastAttemptAtMs INTEGER,
          lastCompletedAtMs INTEGER,
          lastErrorAtMs INTEGER,
          lastErrorCode TEXT,
          lastErrorMessage TEXT,
          consecutiveFailures INTEGER NOT NULL DEFAULT 0,
          nextEligibleAtMs INTEGER NOT NULL DEFAULT 0,
          lastObservedSeq INTEGER NOT NULL DEFAULT 0,
          lastScannedSeq INTEGER NOT NULL DEFAULT 0,
          lastSemanticSeq INTEGER NOT NULL DEFAULT 0,
          lastHintedSeq INTEGER NOT NULL DEFAULT 0,
          lastDeepIndexedSeq INTEGER NOT NULL DEFAULT 0,
          rawRowsFetched INTEGER NOT NULL DEFAULT 0,
          semanticRowsFound INTEGER NOT NULL DEFAULT 0,
          semanticRowsIndexedLight INTEGER NOT NULL DEFAULT 0,
          semanticRowsIndexedDeep INTEGER NOT NULL DEFAULT 0,
          lightShardCount INTEGER NOT NULL DEFAULT 0,
          deepChunkCount INTEGER NOT NULL DEFAULT 0,
          skippedReason TEXT,
          updatedAtMs INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX memory_session_index_state_status_idx
          ON memory_session_index_state(status, updatedAtMs);
        CREATE TABLE memory_worker_runs (
          runId TEXT PRIMARY KEY,
          startedAtMs INTEGER NOT NULL,
          finishedAtMs INTEGER,
          trigger TEXT NOT NULL,
          indexMode TEXT NOT NULL,
          sessionsConsidered INTEGER NOT NULL DEFAULT 0,
          sessionsProcessed INTEGER NOT NULL DEFAULT 0,
          sessionsIndexed INTEGER NOT NULL DEFAULT 0,
          sessionsSkipped INTEGER NOT NULL DEFAULT 0,
          sessionsFailed INTEGER NOT NULL DEFAULT 0,
          rawRowsFetched INTEGER NOT NULL DEFAULT 0,
          semanticRowsFound INTEGER NOT NULL DEFAULT 0,
          lightShardsCreated INTEGER NOT NULL DEFAULT 0,
          deepChunksCreated INTEGER NOT NULL DEFAULT 0,
          errorCode TEXT,
          errorMessage TEXT
        );
        CREATE TABLE memory_worker_run_skip_reasons (
          runId TEXT NOT NULL,
          reason TEXT NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (runId, reason),
          FOREIGN KEY (runId) REFERENCES memory_worker_runs(runId) ON DELETE CASCADE
        );
      `);
      preview
        .prepare(`
          INSERT INTO summary_shards (
            shardId, sessionId, seqFrom, seqTo, createdAtFromMs, createdAtToMs,
            summary, keywordsText, entitiesText, decisionsText
          ) VALUES (1, 'sess_preview', 4, 8, 1000, 2000, ?, '', '', '');
        `)
        .run('Обсудили Unicode migration and previewascii');
      preview.prepare(`INSERT INTO summary_terms (term, shardId) VALUES ('previewascii', 1);`).run();
      preview.prepare(`
        INSERT INTO session_cursors (
          sessionId, lastObservedSeq, lastHintedSeq, lastDeepIndexedSeq, updatedAtMs
        ) VALUES ('sess_preview', 12, 8, 6, 1234);
      `).run();
      preview.prepare(`
        INSERT INTO memory_session_index_state (
          sessionId, selectedByBackfillPolicy, coveragePolicyJson, status,
          lastObservedSeq, lastScannedSeq, lastSemanticSeq, lastHintedSeq,
          lightShardCount, updatedAtMs
        ) VALUES ('sess_preview', 'all_history', '{"type":"full"}', 'indexed', 12, 12, 8, 8, 1, 1234);
      `).run();
      preview.prepare(`
        INSERT INTO memory_worker_runs (
          runId, startedAtMs, finishedAtMs, trigger, indexMode,
          sessionsConsidered, sessionsProcessed, sessionsIndexed
        ) VALUES ('preview-run', 1000, 1200, 'interval', 'summaries', 1, 1, 1);
      `).run();
      preview.prepare(`
        INSERT INTO memory_worker_run_skip_reasons (runId, reason, count)
        VALUES ('preview-run', 'already_indexed', 2);
      `).run();
      preview.exec('PRAGMA user_version=3');
      preview.close();

      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      expect(db.search({ query: 'Обсудили', scope: { type: 'global' }, maxResults: 10 }))
        .toEqual([expect.objectContaining({ sessionId: 'sess_preview', seqFrom: 4, seqTo: 8 })]);
      expect(db.getSessionCursors({ sessionId: 'sess_preview', nowMs: 5000 })).toMatchObject({
        lastObservedSeq: 12,
        lastHintedSeq: 8,
        lastDeepIndexedSeq: 6,
      });
      expect(db.getMemoryIndexQueueTelemetry()).toMatchObject({
        selectedSessionCount: 1,
        indexedSessionCount: 1,
        lightShardCount: 1,
        lastRun: {
          runId: 'preview-run',
          sessionsIndexed: 1,
          skipReasons: { already_indexed: 2 },
        },
      });

      db.close();
      const migrated = openSqliteDatabaseSync(dbPath);
      expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 });
      expect(migrated.prepare(`PRAGMA table_info(summary_shards)`).all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'policyKey', dflt_value: "''" })]),
      );
      migrated.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps session cursors intact when budget eviction removes derived shards', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-evict-cursors-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      db.insertSummaryShard({
        sessionId: 'sess_1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1000,
        createdAtToMs: 1000,
        summary: 'oldestuniq',
        keywords: [],
        entities: [],
        decisions: [],
      });
      db.markHintRunSuccess({ sessionId: 'sess_1', seqTo: 2, nowMs: 1000 });
      db.markDeepIndexSuccess({ sessionId: 'sess_1', seqTo: 2, nowMs: 1000 });

      expect(db.deleteOldestSummaryShards({ limit: 1 })).toBe(1);
      expect(countRows(dbPath, 'summary_fts_vocab')).toBe(0);

      expect(db.getSessionCursors({ sessionId: 'sess_1', nowMs: 2000 })).toMatchObject({
        lastHintedSeq: 2,
        lastDeepIndexedSeq: 2,
      });

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
