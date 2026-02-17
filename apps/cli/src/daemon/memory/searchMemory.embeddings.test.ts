import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { searchTier2Memory } from './searchMemory';

describe('searchTier2Memory (embeddings rerank)', () => {
  it('reranks deep hits when embeddings are available and enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-search-emb-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.init();
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 10,
        text: 'Older chunk mentions openclaw.',
      });
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 2,
        seqTo: 3,
        createdAtFromMs: 2,
        createdAtToMs: 20,
        text: 'Newer chunk also mentions openclaw.',
      });

      db.upsertEmbedding({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 1,
        provider: 'test',
        modelId: 'm1',
        embedding: new Float32Array([1, 0]),
        updatedAtMs: 1,
      });
      db.upsertEmbedding({
        sessionId: 's1',
        seqFrom: 2,
        seqTo: 3,
        provider: 'test',
        modelId: 'm1',
        embedding: new Float32Array([0, 1]),
        updatedAtMs: 1,
      });
      db.close();

      // Use `as any` to allow RED→GREEN without changing the function signature first.
      const result = await (searchTier2Memory as any)({
        dbPath,
        query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep', maxResults: 2 },
        previewChars: 200,
        embeddings: { enabled: true, provider: 'test', modelId: 'm1', wFts: 0.1, wEmb: 0.9 },
        embedQuery: async () => new Float32Array([1, 0]),
        candidateLimit: 10,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.hits[0]?.seqFrom).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

