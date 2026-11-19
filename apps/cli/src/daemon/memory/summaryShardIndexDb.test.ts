import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';

describe('summaryShardIndexDb', () => {
  it('matches Unicode letter case in phrases and exclusions', () => {
    const db = openSummaryShardIndexDb({ dbPath: ':memory:' });
    try {
      ['ÜMBRELLA PIGS', 'ümbrella pigs'].forEach((text, index) => db.insertSummaryShard({
        sessionId: `s${index}`, seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1,
        summary: text,
        keywords: [], entities: [], decisions: [],
      }));
      expect(db.search({ query: '"ümbrella pigs"', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(2);
      expect(db.search({ query: '-ümbrella', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(db.findExcludedSessionIds({ query: '-ümbrella', scope: { type: 'global' } }).sort()).toEqual(['s0', 's1']);
    } finally {
      db.close();
    }
  });
  it('excludes terms and phrases across the indexed session, including exclusion-only queries', () => {
    const db = openSummaryShardIndexDb({ dbPath: ':memory:' });
    try {
      const texts = [
        'Continue with umbrella pigs',
        'Continue with umbrella dancing pigs',
        'Continue with dancing pigs',
        'Unrelated',
        'umbrella pigs',
      ];
      texts.forEach((text, index) => db.insertSummaryShard({
        sessionId: index === 4 ? 's2' : `s${index}`,
        seqFrom: index + 1,
        seqTo: index + 1,
        createdAtFromMs: index,
        createdAtToMs: index,
        summary: text,
        keywords: [], entities: [], decisions: [],
      }));
      const search = (query: string) => db.search({ query, scope: { type: 'global' }, maxResults: 10 })
        .map((hit) => hit.sessionId);
      expect(search('"continue with" -"umbrella pigs"')).toEqual(['s1']);
      expect(search('"continue with" -umbrella')).toEqual([]);
      expect(search('-"umbrella pigs"')).toEqual(['s3', 's1']);
      expect(search('-umbrella')).toEqual(['s3']);
    } finally {
      db.close();
    }
  });
  it('requires literal quoted phrases before applying the result limit', () => {
    const db = openSummaryShardIndexDb({ dbPath: ':memory:' });
    try {
      const texts = [
        'Please CONTINUE WITH the release candidate.',
        'Continue the release candidate with care.',
        'Continue a task with the release candidate.',
        'Continue with another task.',
      ];
      texts.forEach((text, index) => db.insertSummaryShard({
        sessionId: `s${index}`,
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: index,
        createdAtToMs: index,
        summary: text,
        keywords: [], entities: [], decisions: [],
      }));
      const search = (query: string) => db.search({ query, scope: { type: 'global' }, maxResults: 1 })
        .map((hit) => hit.sessionId);
      expect(search('"continue with" "release candidate"')).toEqual(['s0']);
      expect(search('"continue a with"')).toEqual([]);
      expect(search('"continue with"')).toEqual(['s3']);
      expect(db.search({ query: '"continue with"', scope: { type: 'session', sessionId: 's1' }, maxResults: 10 })).toEqual([]);
    } finally {
      db.close();
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

  it('does not return shards that only match generic sentinel prefix terms', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-distinctive-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      db.insertSummaryShard({
        sessionId: 'sess_1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1000,
        createdAtToMs: 2000,
        summary: 'Summary shard for OPENCLAW_MEMORY_SENTINEL_SEMANTIC_alpha',
        keywords: ['openclaw', 'OPENCLAW_MEMORY_SENTINEL_SEMANTIC_alpha'],
        entities: [],
        decisions: [],
      });

      const hits = db.search({
        query: 'OPENCLAW_MEMORY_SENTINEL_TOOL_NOISE_beta',
        scope: { type: 'global' },
        maxResults: 10,
      });
      expect(hits).toEqual([]);

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

  it('persists per-session index progress telemetry and aggregates queue status', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-db-queue-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const db = openSummaryShardIndexDb({ dbPath });
      db.init();

      db.recordMemorySessionIndexState({
        sessionId: 'sess-indexed',
        status: 'indexed',
        queuedReason: 'backfill',
        selectedByBackfillPolicy: 'all_history',
        coveragePolicyJson: '{"type":"full"}',
        lastQueuedAtMs: 1000,
        lastStartedAtMs: 1100,
        lastSuccessAtMs: 1200,
        lastCompletedAtMs: 1200,
        lastObservedSeq: 9,
        lastScannedSeq: 9,
        lastSemanticSeq: 8,
        lastHintedSeq: 8,
        rawRowsFetched: 12,
        semanticRowsFound: 8,
        semanticRowsIndexedLight: 8,
        lightShardCount: 1,
        updatedAtMs: 1300,
      });
      db.recordMemorySessionIndexState({
        sessionId: 'sess-empty',
        status: 'empty',
        selectedByBackfillPolicy: 'all_history',
        coveragePolicyJson: '{"type":"full"}',
        skippedReason: 'no_semantic_rows',
        rawRowsFetched: 4,
        semanticRowsFound: 0,
        updatedAtMs: 1301,
      });
      db.recordMemoryWorkerRun({
        runId: 'run-1',
        trigger: 'tick',
        indexMode: 'hints',
        startedAtMs: 2000,
        finishedAtMs: 2500,
        sessionsConsidered: 2,
        sessionsProcessed: 2,
        sessionsIndexed: 1,
        sessionsSkipped: 1,
        rawRowsFetched: 16,
        semanticRowsFound: 8,
        lightShardsCreated: 1,
        skipReasons: { no_semantic_rows: 1 },
      });

      expect(db.getMemoryIndexQueueTelemetry()).toEqual(expect.objectContaining({
        selectedSessionCount: 2,
        indexedSessionCount: 1,
        emptySessionCount: 1,
        queuedSessionCount: 0,
        failedSessionCount: 0,
        waitingSessionCount: 0,
        rawRowsFetched: 16,
        semanticRowsFound: 8,
        lightShardCount: 1,
        lastRun: expect.objectContaining({
          runId: 'run-1',
          sessionsProcessed: 2,
          skipReasons: { no_semantic_rows: 1 },
        }),
      }));

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
});
