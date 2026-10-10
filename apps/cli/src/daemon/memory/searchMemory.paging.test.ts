import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { searchTier2Memory } from './searchMemory';

describe('memory search paging and snippets', () => {
  it('filters native Agent and source before paging and binds the continuation to that scope', async () => {
    const dir = await createTempDir('happier-memory-history-scope-');
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      for (const [id, agentId, sourceKey, time] of [
        ['selected-1', 'pi', 'local', 1], ['selected-2', 'pi', 'local', 2],
        ['other-source', 'pi', 'work', 3], ['other-agent', 'claude', 'local', 4],
      ] as const) db.insertChunk({ sessionId: id, source: { type: 'external_transcript', agentId, sourceKey, nativeSessionId: id },
        sourceItemId: id, seqFrom: 1, seqTo: 1, createdAtFromMs: time, createdAtToMs: time, text: 'quartz native conversation' });
      db.close();
      const query = { v: 1 as const, query: 'quartz', scope: { type: 'global' as const }, mode: 'deep' as const,
        corpora: ['external_transcripts' as const], maxResults: 1, externalSource: { agentId: 'pi', sourceKey: 'local' } };
      const first = await searchTier2Memory({ dbPath, previewChars: 64, query });
      expect(first).toMatchObject({ ok: true, hits: [{ sourceItemId: 'selected-2' }], hasMore: true });
      if (!first.ok || !first.nextCursor) throw new Error('Expected scoped continuation');
      const next = await searchTier2Memory({ dbPath, previewChars: 64, query: { ...query, cursor: first.nextCursor } });
      expect(next).toMatchObject({ ok: true, hits: [{ sourceItemId: 'selected-1' }], hasMore: false });
      const changed = await searchTier2Memory({ dbPath, previewChars: 64,
        query: { ...query, externalSource: { agentId: 'pi', sourceKey: 'work' }, cursor: first.nextCursor } });
      expect(changed).toMatchObject({ ok: false, errorCode: 'memory_invalid_query' });
    } finally { await removeTempDir(dir); }
  });
  it('retains hinted Happier sessions alongside explicitly requested native transcripts', async () => {
    const dir = await createTempDir('happier-memory-corpora-');
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const summaryDbPath = join(dir, 'summary.sqlite');
      const summary = openSummaryShardIndexDb({ dbPath: summaryDbPath });
      summary.insertSummaryShard({ sessionId: 'local', seqFrom: 1, seqTo: 1, createdAtFromMs: 1,
        createdAtToMs: 1, summary: 'quartz hinted conversation', keywords: [], entities: [], decisions: [] });
      summary.close();
      const source = { type: 'external_transcript' as const, agentId: 'pi', sourceKey: 'pi-root', nativeSessionId: 'native' };
      const db = openDeepIndexDb({ dbPath });
      db.insertChunk({ sessionId: 'internal-native-key', source, sourceItemId: 'native-message',
        seqFrom: 1, seqTo: 1, createdAtFromMs: 2, createdAtToMs: 2, text: 'quartz native conversation' });
      db.close();
      const result = await searchTier2Memory({ dbPath, sessionSummaryDbPath: summaryDbPath, previewChars: 64,
        query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'auto', maxResults: 10,
          corpora: ['sessions', 'external_transcripts'] } });
      expect(result).toMatchObject({ ok: true, hits: [
        { type: 'external_transcript', source, sourceItemId: 'native-message' },
        { sessionId: 'local', summary: 'quartz hinted conversation' },
      ] });
      if (result.ok) expect(result.hits[0]).not.toHaveProperty('seqFrom');
      const excludedAgent = await searchTier2Memory({ dbPath, previewChars: 64, externalAgentIds: [],
        query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'deep',
          corpora: ['external_transcripts'] } });
      expect(excludedAgent).toMatchObject({ ok: true, hits: [] });
      const legacy = await searchTier2Memory({ dbPath, previewChars: 64,
        query: { v: 1, query: 'quartz', scope: { type: 'global' }, mode: 'deep', maxResults: 10 } });
      expect(legacy).toMatchObject({ ok: true, hits: [] });
    } finally { await removeTempDir(dir); }
  });
  it('centres the preview on the match and pages the filtered corpus without duplicate hits', async () => {
    const dir = await createTempDir('happier-memory-paging-');
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      for (const seq of [1, 2, 3, 4]) db.insertChunk({ sessionId: 'local', seqFrom: seq, seqTo: seq,
        createdAtFromMs: seq, createdAtToMs: seq, text: `${'background '.repeat(200)}quartz result ${seq}` });
      db.close();
      const query = { v: 1 as const, query: 'quartz', scope: { type: 'global' as const }, mode: 'deep' as const,
        maxResults: 1, createdAfterMs: 2, createdBeforeMs: 4 };
      let cursor: string | undefined;
      const ranges: number[] = [];
      do {
        const page = await searchTier2Memory({ dbPath, query: { ...query, ...(cursor ? { cursor } : {}) }, previewChars: 64 });
        expect(page.ok).toBe(true);
        if (!page.ok) throw new Error(page.error);
        for (const hit of page.hits) {
          expect(hit.summary).toContain('quartz');
          if (hit.type === undefined) ranges.push(hit.seqFrom);
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(ranges).toEqual([4, 3, 2]);
      const invalid = await searchTier2Memory({ dbPath, query: { ...query, cursor: 'broken' }, previewChars: 64 });
      expect(invalid).toMatchObject({ ok: false, errorCode: 'memory_invalid_query' });
    } finally { await removeTempDir(dir); }
  });
});
