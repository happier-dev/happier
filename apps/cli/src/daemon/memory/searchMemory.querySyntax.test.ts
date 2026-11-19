import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { searchTier1Memory, searchTier2Memory } from './searchMemory';

describe('memory query syntax across the daemon response boundary', () => {
  it.each(['hints', 'deep'] as const)('reports indexed exclusions even without a positive hit in %s mode', async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-query-syntax-'));
    const dbPath = join(dir, 'index.sqlite');
    try {
      const window = { sessionId: 'blocked', seqFrom: 1, seqTo: 1, createdAtFromMs: 1, createdAtToMs: 1 };
      if (mode === 'deep') {
        const db = openDeepIndexDb({ dbPath });
        db.insertChunk({ ...window, text: 'umbrella pigs' });
        db.close();
      } else {
        const db = openSummaryShardIndexDb({ dbPath });
        db.insertSummaryShard({ ...window, summary: 'umbrella pigs', keywords: [], entities: [], decisions: [] });
        db.close();
      }
      const query = { v: 1 as const, query: 'continue -"umbrella pigs"', scope: { type: 'global' as const }, mode };
      const result = mode === 'deep'
        ? await searchTier2Memory({ dbPath, query, previewChars: 5 })
        : searchTier1Memory({ dbPath, query });
      expect(result).toMatchObject({ ok: true, hits: [], querySyntaxVersion: 1, excludedSessionIds: ['blocked'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
