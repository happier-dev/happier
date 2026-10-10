import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { searchTier2Memory } from './searchMemory';

describe('searchTier2Memory (embeddings rerank)', () => {
  it('does not substitute transcript hits when only documents are requested and their scope is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-search-corpora-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.insertChunk({ sessionId: 's1', seqFrom: 1, seqTo: 1,
        createdAtFromMs: 1, createdAtToMs: 1, text: 'openclaw' });
      db.close();
      const result = await searchTier2Memory({
        dbPath,
        query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep', corpora: ['documents'] },
        previewChars: 200,
      });
      expect(result).toMatchObject({ ok: true, hits: [], documents: { state: 'unavailable' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('limits text-only results after selecting the larger candidate pool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-memory-search-limit-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.init();
      for (const seq of [1, 2, 3]) {
        db.insertChunk({
          sessionId: 's1',
          seqFrom: seq,
          seqTo: seq,
          createdAtFromMs: seq,
          createdAtToMs: seq,
          text: 'openclaw',
        });
      }
      db.close();

      const result = await searchTier2Memory({
        dbPath,
        query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep', maxResults: 1 },
        previewChars: 200,
        candidateLimit: 3,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.hits.map((hit) => hit.type === undefined ? hit.seqFrom : null)).toEqual([3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
        text: 'Older detailed discussion mentions openclaw among several other conversation topics and background notes.',
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
        provider: 'local_transformers',
        modelId: 'm1',
        embedding: new Float32Array([1, 0]),
        updatedAtMs: 1,
      });
      db.upsertEmbedding({
        sessionId: 's1',
        seqFrom: 2,
        seqTo: 3,
        provider: 'local_transformers',
        modelId: 'm1',
        embedding: new Float32Array([0, 1]),
        updatedAtMs: 1,
      });
      db.close();

      const baseline = await searchTier2Memory({
        dbPath,
        query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep', maxResults: 1 },
        previewChars: 200,
        candidateLimit: 10,
      });
      const result = await searchTier2Memory({
        dbPath,
        query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep', maxResults: 1 },
        previewChars: 200,
        embeddings: {
          enabled: true,
          mode: 'custom',
          presetId: null,
          providerKind: 'local_transformers',
          modelId: 'm1',
          blend: { ftsWeight: 0.1, embeddingWeight: 0.9 },
          providerConfig: null,
        },
        embedQuery: async () => new Float32Array([1, 0]),
        candidateLimit: 10,
      });

      expect(baseline.ok).toBe(true);
      if (baseline.ok) expect(baseline.hits[0]?.type === undefined ? baseline.hits[0].seqFrom : null).toBe(2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.type === undefined ? result.hits[0].seqFrom : null).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to text-only ranking when query embedding generation fails', async () => {
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
      db.close();

      const baseline = await searchTier2Memory({
        dbPath,
        query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep', maxResults: 2 },
        previewChars: 200,
        candidateLimit: 10,
      });
      const result = await searchTier2Memory({
        dbPath,
        query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'deep', maxResults: 2 },
        previewChars: 200,
        embeddings: {
          enabled: true,
          mode: 'custom',
          presetId: null,
          providerKind: 'local_transformers',
          modelId: 'm1',
          blend: { ftsWeight: 0.1, embeddingWeight: 0.9 },
          providerConfig: null,
        },
        embedQuery: async () => {
          throw new Error('remote embeddings unavailable');
        },
        candidateLimit: 10,
      });

      expect(baseline.ok).toBe(true);
      expect(result.ok).toBe(true);
      if (!baseline.ok || !result.ok) return;
      expect(result.hits).toHaveLength(2);
      expect(result.hits.map((hit) => hit.type === undefined ? hit.seqFrom : null)).toEqual(
        baseline.hits.map((hit) => hit.type === undefined ? hit.seqFrom : null),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
