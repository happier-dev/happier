import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';

describe('syncMemoryHintsForSessionsOnce', () => {
  it('generates and indexes a new summary shard when a session has enough new messages', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-sync-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let committed = 0;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            maxKeywords: 5,
            maxEntities: 5,
            maxDecisions: 5,
            maxRunsPerHour: 999,
            maxShardsPerSession: 250,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        now: () => 5000,
        fetchRecentDecryptedRows: async () => rows,
        runSummarizer: async () =>
          JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: 40,
              createdAtFromMs: 1000,
              createdAtToMs: 1039,
              summary: 'We discussed OpenClaw memory search.',
              keywords: ['openclaw'],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          }),
        commitArtifacts: async () => {
          committed += 1;
        },
      });

      expect(committed).toBe(1);

      const hits = tier1.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 });
      expect(hits.length).toBe(1);
      expect(hits[0]!.sessionId).toBe('sess-1');

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not backfill old messages when backfillPolicy=new_only and the session is uninitialized', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-new-only-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let summarizerCalls = 0;
      let committed = 0;

      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'new_only',
          hints: {
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            maxKeywords: 5,
            maxEntities: 5,
            maxDecisions: 5,
            maxRunsPerHour: 999,
            maxShardsPerSession: 250,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        now: () => 5000,
        fetchRecentDecryptedRows: async () => rows as any,
        runSummarizer: async () => {
          summarizerCalls += 1;
          return '{}';
        },
        commitArtifacts: async () => {
          committed += 1;
        },
      });

      expect(summarizerCalls).toBe(0);
      expect(committed).toBe(0);

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('respects maxRunsPerHour by throttling repeated hint runs for the same session', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-throttle-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows40 = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));
      const rows80 = Array.from({ length: 80 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 2000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let rows: any[] = rows40;
      let summarizerCalls = 0;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            maxKeywords: 5,
            maxEntities: 5,
            maxDecisions: 5,
            maxRunsPerHour: 1,
            maxShardsPerSession: 250,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        now: () => 10_000,
        fetchRecentDecryptedRows: async () => rows as any,
        runSummarizer: async () => {
          summarizerCalls += 1;
          return JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: rows.length,
              createdAtFromMs: 1000,
              createdAtToMs: 1000 + rows.length - 1,
              summary: 'first',
              keywords: ['first'],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          });
        },
        commitArtifacts: async () => {},
      });

      rows = rows80;
      await syncMemoryHintsForSessionsOnce({
        sessionIds: ['sess-1'],
        tier1,
        settings: {
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            maxKeywords: 5,
            maxEntities: 5,
            maxDecisions: 5,
            maxRunsPerHour: 1,
            maxShardsPerSession: 250,
            failureBackoffBaseMs: 0,
            failureBackoffMaxMs: 0,
          },
        },
        now: () => 10_100,
        fetchRecentDecryptedRows: async () => rows as any,
        runSummarizer: async () => {
          summarizerCalls += 1;
          return JSON.stringify({
            shard: {
              v: 1,
              seqFrom: 1,
              seqTo: rows.length,
              createdAtFromMs: 1000,
              createdAtToMs: 1000 + rows.length - 1,
              summary: 'second',
              keywords: ['second'],
              entities: [],
              decisions: [],
            },
            synopsis: null,
          });
        },
        commitArtifacts: async () => {},
      });

      expect(summarizerCalls).toBe(1);
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evicts older hint shards when maxShardsPerSession is exceeded', async () => {
    const { syncMemoryHintsForSessionsOnce } = await import('./syncMemoryHintsForSessionsOnce');

    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-evict-'));
    try {
      const dbPath = join(dir, 'memory.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath });
      tier1.init();

      const rows40 = Array.from({ length: 40 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 1000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));
      const rows80 = Array.from({ length: 80 }).map((_, i) => ({
        seq: i + 1,
        createdAtMs: 2000 + i,
        role: 'user' as const,
        content: { type: 'text', text: `message ${i} about openclaw` },
      }));

      let rows: any[] = rows40;
      let call = 0;
      const runOnce = async () => {
        await syncMemoryHintsForSessionsOnce({
          sessionIds: ['sess-1'],
          tier1,
          settings: {
            enabled: true,
            indexMode: 'hints',
            backfillPolicy: 'all_history',
            hints: {
              updateMode: 'continuous',
              idleDelayMs: 0,
              windowSizeMessages: 40,
              maxShardChars: 12_000,
              maxSummaryChars: 500,
              maxKeywords: 5,
              maxEntities: 5,
              maxDecisions: 5,
              maxRunsPerHour: 999,
              maxShardsPerSession: 1,
              failureBackoffBaseMs: 0,
              failureBackoffMaxMs: 0,
            },
          },
          now: () => 50_000 + call,
          fetchRecentDecryptedRows: async () => rows as any,
          runSummarizer: async () => {
            call += 1;
            return JSON.stringify({
              shard: {
                v: 1,
                seqFrom: 1,
                seqTo: rows.length,
                createdAtFromMs: 1000,
                createdAtToMs: 1000 + rows.length - 1,
                summary: call === 1 ? 'first term' : 'second term',
                keywords: [call === 1 ? 'firstterm' : 'secondterm'],
                entities: [],
                decisions: [],
              },
              synopsis: null,
            });
          },
          commitArtifacts: async () => {},
        });
      };

      await runOnce();
      rows = rows80;
      await runOnce();

      expect(tier1.search({ query: 'firstterm', scope: { type: 'session', sessionId: 'sess-1' }, maxResults: 10 })).toEqual([]);
      expect(tier1.search({ query: 'secondterm', scope: { type: 'session', sessionId: 'sess-1' }, maxResults: 10 }).length).toBe(1);

      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
