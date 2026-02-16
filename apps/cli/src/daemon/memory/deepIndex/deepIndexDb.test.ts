import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDeepIndexDb } from './deepIndexDb';

describe('deepIndexDb', () => {
  it('indexes chunks and can search by term (global scope)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.init();

      db.insertChunk({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 10,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'We discussed Openclaw integration and memory search.',
      });
      db.insertChunk({
        sessionId: 's2',
        seqFrom: 0,
        seqTo: 5,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'Something unrelated.',
      });

      const hits = db.search({ query: 'openclaw', scope: { type: 'global' }, maxResults: 10 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.sessionId).toBe('s1');
      expect(hits[0]!.seqFrom).toBe(0);
      expect(hits[0]!.seqTo).toBe(10);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('respects session scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.init();

      db.insertChunk({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 10,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'Openclaw is mentioned here.',
      });
      db.insertChunk({
        sessionId: 's2',
        seqFrom: 0,
        seqTo: 10,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'Openclaw is also mentioned here.',
      });

      const hits = db.search({ query: 'openclaw', scope: { type: 'session', sessionId: 's2' }, maxResults: 10 });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.sessionId).toBe('s2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evicts oldest chunks globally and cascades term rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-evict-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.init();

      db.insertChunk({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        text: 'oldchunkuniq',
      });
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 2,
        seqTo: 3,
        createdAtFromMs: 2,
        createdAtToMs: 2,
        text: 'newchunkuniq',
      });

      expect(db.search({ query: 'oldchunkuniq', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);
      expect(db.search({ query: 'newchunkuniq', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);

      const deleted = db.deleteOldestChunks({ limit: 1 });
      expect(deleted).toBe(1);

      expect(db.search({ query: 'oldchunkuniq', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(db.search({ query: 'newchunkuniq', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);

      db.checkpointAndVacuum();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stores and loads embeddings for deep chunks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-embeddings-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');

      type EmbeddingKey = { sessionId: string; seqFrom: number; seqTo: number };
      type EmbeddingsDb = ReturnType<typeof openDeepIndexDb> & Readonly<{
        upsertEmbedding: (args: Readonly<{
          sessionId: string;
          seqFrom: number;
          seqTo: number;
          provider: string;
          modelId: string;
          embedding: Float32Array;
          updatedAtMs: number;
        }>) => void;
        loadEmbeddings: (args: Readonly<{
          provider: string;
          modelId: string;
          keys: readonly EmbeddingKey[];
        }>) => Map<string, Float32Array>;
      }>;

      const db = openDeepIndexDb({ dbPath }) as unknown as EmbeddingsDb;
      db.init();

      db.insertChunk({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'openclaw',
      });

      db.upsertEmbedding({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 1,
        provider: 'test',
        modelId: 'm1',
        embedding: new Float32Array([1, 2, 3]),
        updatedAtMs: 123,
      });

      const map = db.loadEmbeddings({
        provider: 'test',
        modelId: 'm1',
        keys: [{ sessionId: 's1', seqFrom: 0, seqTo: 1 }],
      });
      const got = map.get('s1:0-1');
      expect(got).toBeTruthy();
      expect(Array.from(got ?? [])).toEqual([1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
