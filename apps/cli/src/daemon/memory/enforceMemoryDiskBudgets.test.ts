import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { enforceMemoryDiskBudgets } from './enforceMemoryDiskBudgets';

describe('enforceMemoryDiskBudgets', () => {
  it('evicts tier-1 and deep rows when budgets are exceeded', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-budgets-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      tier1.insertSummaryShard({
        sessionId: 's1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        summary: 'termone',
        keywords: [],
        entities: [],
        decisions: [],
      });
      deep.insertChunk({
        sessionId: 's1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'termtwo',
      });

      expect(tier1.search({ query: 'termone', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);
      expect(deep.search({ query: 'termtwo', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);

      await enforceMemoryDiskBudgets({
        tier1,
        deep,
        tier1DbPath: tier1Path,
        deepDbPath: deepPath,
        budgets: { tier1Bytes: 0, deepBytes: 0 },
      });

      expect(tier1.search({ query: 'termone', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.search({ query: 'termtwo', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

