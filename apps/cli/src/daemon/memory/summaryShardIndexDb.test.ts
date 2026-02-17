import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';

describe('summaryShardIndexDb', () => {
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
});
