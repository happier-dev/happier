import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StatementSync } from 'node:sqlite';
import { vi } from 'vitest';

import { openSqliteDatabaseSync } from '../../persistence/sqliteSync';
import { openDeepIndexDb } from './deepIndexDb';

function countRows(dbPath: string, table: string): number {
  const db = openSqliteDatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as any;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

describe('deepIndexDb', () => {
  it('persists facts, archive and instruction text under current qualified document revisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-documents-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const ref = { serverId: 'home-one', artifactId: 'same-id' };
      const revision = { headerVersion: 2, bodyVersion: 7 };
      const topicLocation = { type: 'topic' as const, title: 'Engineering / "部署"' };
      let db = openDeepIndexDb({ dbPath });
      db.replaceDocumentIndexData({ ref, revision, entries: [
        { factId: 'active', location: 'facts', text: 'Searchable current fact' },
        { factId: 'expired', location: 'facts', text: 'Searchable expired факт' },
        { factId: 'forgotten', location: 'archive', text: 'Searchable archived fact' },
        { factId: 'topic-only', location: topicLocation, text: 'Searchable topic-only deployment detail' },
      ] });
      db.replaceDocumentIndexData({
        ref: { serverId: 'home-two', artifactId: 'same-id' }, revision,
        entries: [{ location: 'document', text: 'Searchable instruction text' }],
      });
      db.close();
      db = openDeepIndexDb({ dbPath });

      const hits = db.searchDocuments({ query: 'searchable', eligibleDocuments: [{ ref, revision }], maxResults: 10 });
      expect(hits).toHaveLength(4);
      expect(hits.map((hit) => hit.factId).sort()).toEqual(['active', 'expired', 'forgotten', 'topic-only']);
      expect(hits.every((hit) => hit.ref.serverId === 'home-one' && hit.revision.bodyVersion === 7)).toBe(true);
      expect(hits.find((hit) => hit.factId === 'forgotten')?.location).toBe('archive');
      expect(hits.find((hit) => hit.factId === 'topic-only')?.location).toEqual(topicLocation);
      expect(db.searchDocuments({ query: 'факт', eligibleDocuments: [{ ref, revision }], maxResults: 10 }))
        .toEqual([expect.objectContaining({ factId: 'expired' })]);
      expect(db.searchDocuments({
        query: 'instruction', eligibleDocuments: [{ ref: { serverId: 'home-two', artifactId: 'same-id' }, revision }], maxResults: 10,
      })).toEqual([expect.objectContaining({ location: 'document', text: 'Searchable instruction text' })]);
      expect(db.search({ query: 'searchable', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(db.getDeepIndexStats()).toMatchObject({ searchableDocumentCount: 2, deepDocumentEntryCount: 5 });
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('opens the legacy location table without losing documents, terms or Session data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-documents-topics-upgrade-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const ref = { serverId: 'home', artifactId: 'retained' };
      const revision = { headerVersion: 1, bodyVersion: 1 };
      let db = openDeepIndexDb({ dbPath });
      db.insertChunk({ sessionId: 'retained-session', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2, text: 'Retained transcript' });
      db.upsertEmbedding({ sessionId: 'retained-session', seqFrom: 1, seqTo: 2, provider: 'test', modelId: 'test', embedding: new Float32Array([1]), updatedAtMs: 2 });
      db.replaceDocumentIndexData({ ref, revision, entries: [{ factId: 'retained-fact', location: 'facts', text: 'Retained searchable fact' }] });
      db.close();

      const legacyDb = openSqliteDatabaseSync(dbPath);
      try {
        // D4's incumbent persisted location declaration, before named topics.
        legacyDb.exec(`
          PRAGMA foreign_keys=OFF;
          BEGIN IMMEDIATE;
          CREATE TABLE legacy_document_entries (
            entryId INTEGER PRIMARY KEY AUTOINCREMENT,
            documentId INTEGER NOT NULL,
            factId TEXT,
            location TEXT NOT NULL CHECK (location IN ('facts', 'archive', 'document')),
            text TEXT NOT NULL,
            FOREIGN KEY (documentId) REFERENCES indexed_documents(documentId) ON DELETE CASCADE
          );
          INSERT INTO legacy_document_entries SELECT * FROM document_entries;
          DROP TABLE document_entries;
          ALTER TABLE legacy_document_entries RENAME TO document_entries;
          CREATE INDEX document_entries_by_document ON document_entries(documentId);
          COMMIT;
          PRAGMA foreign_keys=ON;
        `);
      } finally {
        legacyDb.close();
      }

      db = openDeepIndexDb({ dbPath });
      expect(db.searchDocuments({ query: 'retained', eligibleDocuments: [{ ref, revision }], maxResults: 10 }))
        .toEqual([expect.objectContaining({ factId: 'retained-fact', location: 'facts' })]);
      expect(db.search({ query: 'retained', scope: { type: 'global' }, maxResults: 10 }))
        .toEqual([expect.objectContaining({ sessionId: 'retained-session' })]);
      expect(db.loadEmbeddings({ provider: 'test', modelId: 'test', keys: [{ sessionId: 'retained-session', seqFrom: 1, seqTo: 2 }] }).get('retained-session:1-2'))
        .toEqual(new Float32Array([1]));
      const topicRef = { ...ref, artifactId: 'topic' };
      const location = { type: 'topic' as const, title: 'Deployment' };
      db.replaceDocumentIndexData({ ref: topicRef, revision, entries: [{ factId: 'topic-fact', location, text: 'Retained topic detail' }] });
      db.close();
      db = openDeepIndexDb({ dbPath });
      expect(db.searchDocuments({ query: 'topic', eligibleDocuments: [{ ref: topicRef, revision }], maxResults: 10 }))
        .toEqual([expect.objectContaining({ factId: 'topic-fact', location })]);
      expect(db.pruneDocumentIndexData({ eligibleDocuments: [{ ref: topicRef, revision }] })).toBe(1);
      expect(countRows(dbPath, 'document_terms')).toBe(3);
      db.close();
      const inspectedDb = openSqliteDatabaseSync(dbPath);
      try {
        expect(inspectedDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        inspectedDb.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('filters revoked, detached and stale revisions before limiting document results and prunes derived text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-documents-eligibility-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      const revision = { headerVersion: 1, bodyVersion: 1 };
      const ref = { serverId: 'home', artifactId: 'current' };
      for (const artifactId of ['revoked', 'detached', 'current']) {
        db.replaceDocumentIndexData({ ref: { ...ref, artifactId }, revision, entries: [{ location: 'document', text: 'shared candidate' }] });
      }
      expect(db.searchDocuments({ query: 'shared', eligibleDocuments: [{ ref, revision }], maxResults: 1 }))
        .toEqual([expect.objectContaining({ ref })]);
      const manyEligibleDocuments = Array.from({ length: 8_200 }, (_, index) => ({
        ref: { serverId: 'home', artifactId: `other-${index}` }, revision,
      }));
      expect(db.searchDocuments({ query: 'shared', eligibleDocuments: [...manyEligibleDocuments, { ref, revision }, { ref, revision }], maxResults: 1 }))
        .toEqual([expect.objectContaining({ ref, rank: -1, score: 1 })]);
      expect(db.searchDocuments({ query: 'shared', eligibleDocuments: [], maxResults: 10 })).toEqual([]);
      expect(db.searchDocuments({ query: 'shared', eligibleDocuments: [{ ref, revision: { ...revision, headerVersion: 2 } }], maxResults: 10 })).toEqual([]);
      expect(db.searchDocuments({ query: 'shared', eligibleDocuments: [{ ref, revision: { ...revision, bodyVersion: 2 } }], maxResults: 10 })).toEqual([]);
      db.replaceDocumentIndexData({ ref, revision: { ...revision, bodyVersion: 2 }, entries: [{ factId: 'new', location: 'facts', text: 'replacement content' }] });
      expect(db.searchDocuments({ query: 'shared', eligibleDocuments: [{ ref, revision }], maxResults: 10 })).toEqual([]);
      expect(db.pruneDocumentIndexData({ eligibleDocuments: [{ ref, revision: { ...revision, bodyVersion: 2 } }] })).toBe(2);
      expect(countRows(dbPath, 'document_terms')).toBe(2);
      expect(db.getDeepIndexStats()).toMatchObject({ searchableDocumentCount: 1, deepDocumentEntryCount: 1 });
      expect(db.pruneDocumentIndexData({ eligibleDocuments: [] })).toBe(1);
      expect(countRows(dbPath, 'document_terms')).toBe(0);
      expect(countRows(dbPath, 'document_entries')).toBe(0);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clears searchable text and counts when the current document revision becomes empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-documents-empty-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      const ref = { serverId: 'home', artifactId: 'cleared' };
      const revision = { headerVersion: 1, bodyVersion: 1 };
      db.replaceDocumentIndexData({ ref, revision, entries: [{ factId: 'old', location: 'facts', text: 'obsolete searchable text' }] });
      expect(db.getDeepIndexStats()).toMatchObject({ searchableDocumentCount: 1, deepDocumentEntryCount: 1 });

      const emptyRevision = { ...revision, bodyVersion: 2 };
      db.replaceDocumentIndexData({ ref, revision: emptyRevision, entries: [] });
      expect(db.searchDocuments({ query: 'obsolete', eligibleDocuments: [{ ref, revision }], maxResults: 10 })).toEqual([]);
      expect(db.searchDocuments({ query: 'obsolete', eligibleDocuments: [{ ref, revision: emptyRevision }], maxResults: 10 })).toEqual([]);
      expect(db.getDeepIndexStats()).toMatchObject({ searchableDocumentCount: 0, deepDocumentEntryCount: 0 });
      expect(countRows(dbPath, 'document_terms')).toBe(0);
      expect(db.pruneDocumentIndexData({ eligibleDocuments: [{ ref, revision: emptyRevision }] })).toBe(0);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists every Session identity retained by deep chunks or embeddings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-retained-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const db = openDeepIndexDb({ dbPath });
      db.init();
      db.insertChunk({
        sessionId: 'chunk-session',
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        text: 'retained chunk',
      });
      db.upsertEmbedding({
        sessionId: 'embedding-session',
        seqFrom: 7,
        seqTo: 8,
        provider: 'test',
        modelId: 'test-model',
        embedding: new Float32Array([1]),
        updatedAtMs: 1,
      });

      expect([...db.listIndexedSessionIds()].sort()).toEqual([
        'chunk-session',
        'embedding-session',
      ]);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it('applies Session eligibility before the result limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-eligibility-'));
    try {
      const db = openDeepIndexDb({ dbPath: join(dir, 'deep.sqlite') });
      db.init();
      for (let index = 0; index < 3; index += 1) {
        db.insertChunk({
          sessionId: `active-${index}`,
          seqFrom: 1,
          seqTo: 1,
          createdAtFromMs: 100 + index,
          createdAtToMs: 100 + index,
          text: 'shared eligibility term',
        });
      }
      db.insertChunk({
        sessionId: 'archived-target',
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        text: 'shared eligibility term',
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

  it('matches non-ASCII chunk text instead of returning an empty result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-unicode-'));
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
        text: 'Обсудили メモリ検索機能 и Καλημέρα déjà vu',
      });

      for (const query of ['Обсудили', '検索', 'Καλημέρα', 'déjà']) {
        expect(
          db.search({ query, scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId),
          query,
        ).toEqual(['s1']);
      }

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cascades term rows on eviction after the database is reopened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-reopen-evict-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');
      const first = openDeepIndexDb({ dbPath });
      first.init();
      first.close();

      const db = openDeepIndexDb({ dbPath });
      db.init();
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        text: 'oldchunkuniq alpha beta',
      });

      expect(countRows(dbPath, 'chunk_terms')).toBeGreaterThan(0);
      expect(db.deleteOldestChunks({ limit: 1 })).toBe(1);
      expect(countRows(dbPath, 'chunk_terms')).toBe(0);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes embeddings owned by evicted chunks and keeps retained ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-evict-embeddings-'));
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
      for (const key of [{ seqFrom: 0, seqTo: 1 }, { seqFrom: 2, seqTo: 3 }]) {
        db.upsertEmbedding({
          sessionId: 's1',
          seqFrom: key.seqFrom,
          seqTo: key.seqTo,
          provider: 'test',
          modelId: 'm1',
          embedding: new Float32Array([1, 2, 3]),
          updatedAtMs: 10,
        });
      }
      expect(db.getDeepIndexStats().deepEmbeddingCount).toBe(2);

      expect(db.deleteOldestChunks({ limit: 1 })).toBe(1);

      expect(db.getDeepIndexStats().deepEmbeddingCount).toBe(1);
      expect(
        db.loadEmbeddings({ provider: 'test', modelId: 'm1', keys: [{ sessionId: 's1', seqFrom: 0, seqTo: 1 }] }).size,
      ).toBe(0);
      expect(
        db.loadEmbeddings({ provider: 'test', modelId: 'm1', keys: [{ sessionId: 's1', seqFrom: 2, seqTo: 3 }] }).size,
      ).toBe(1);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists chunks missing the selected provider/model embedding even when another model has one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-missing-embeddings-'));
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
        text: 'needs embedding',
      });
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 2,
        seqTo: 3,
        createdAtFromMs: 2,
        createdAtToMs: 2,
        text: 'already embedded',
      });
      db.upsertEmbedding({
        sessionId: 's1',
        seqFrom: 0,
        seqTo: 1,
        provider: 'other',
        modelId: 'other-model',
        embedding: new Float32Array([1, 2]),
        updatedAtMs: 10,
      });
      db.upsertEmbedding({
        sessionId: 's1',
        seqFrom: 2,
        seqTo: 3,
        provider: 'test',
        modelId: 'm1',
        embedding: new Float32Array([1, 2]),
        updatedAtMs: 10,
      });

      const missing = db.listChunksWithoutEmbeddings({ sessionId: 's1', provider: 'test', modelId: 'm1', limit: 10 });
      expect(missing.map((row) => [row.seqFrom, row.seqTo])).toEqual([[0, 1]]);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds chunk terms and drops orphan embeddings when opening a pre-Unicode index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-deep-index-migrate-'));
    try {
      const dbPath = join(dir, 'deep.sqlite');

      const legacy = openSqliteDatabaseSync(dbPath);
      legacy.exec(`PRAGMA foreign_keys=ON;`);
      legacy.exec(`
        CREATE TABLE message_chunks (
          chunkId INTEGER PRIMARY KEY AUTOINCREMENT,
          sessionId TEXT NOT NULL,
          seqFrom INTEGER NOT NULL,
          seqTo INTEGER NOT NULL,
          createdAtFromMs INTEGER NOT NULL,
          createdAtToMs INTEGER NOT NULL,
          text TEXT NOT NULL,
          UNIQUE (sessionId, seqFrom, seqTo)
        );
      `);
      legacy.exec(`
        CREATE TABLE chunk_terms (
          term TEXT NOT NULL,
          chunkId INTEGER NOT NULL,
          PRIMARY KEY (term, chunkId),
          FOREIGN KEY (chunkId) REFERENCES message_chunks(chunkId) ON DELETE CASCADE
        );
      `);
      legacy.exec(`
        CREATE TABLE chunk_embeddings (
          sessionId TEXT NOT NULL,
          seqFrom INTEGER NOT NULL,
          seqTo INTEGER NOT NULL,
          provider TEXT NOT NULL,
          modelId TEXT NOT NULL,
          dims INTEGER NOT NULL,
          embedding BLOB NOT NULL,
          updatedAtMs INTEGER NOT NULL,
          PRIMARY KEY (sessionId, seqFrom, seqTo, provider, modelId)
        );
      `);
      legacy
        .prepare(`
          INSERT INTO message_chunks (chunkId, sessionId, seqFrom, seqTo, createdAtFromMs, createdAtToMs, text)
          VALUES (1, 's1', 0, 1, 1, 1, ?);
        `)
        .run('Обсудили メモリ検索 and legacyascii');
      legacy.prepare(`INSERT INTO chunk_terms (term, chunkId) VALUES ('legacyascii', 1);`).run();
      // Orphan embedding left behind by a pre-change eviction: no chunk owns it.
      legacy
        .prepare(`
          INSERT INTO chunk_embeddings (sessionId, seqFrom, seqTo, provider, modelId, dims, embedding, updatedAtMs)
          VALUES ('s1', 90, 91, 'test', 'm1', 1, ?, 1);
        `)
        .run(Buffer.alloc(4));
      legacy.exec('PRAGMA user_version=1');
      legacy.close();

      const originalAll = StatementSync.prototype.all;
      const allSpy = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...args) {
        if (/FROM\s+message_chunks/i.test(this.sourceSQL) && !/\bLIMIT\b/i.test(this.sourceSQL)) {
          throw new Error('deep migration selected the complete retained corpus');
        }
        return Reflect.apply(originalAll, this, args);
      });
      let db: ReturnType<typeof openDeepIndexDb>;
      try {
        db = openDeepIndexDb({ dbPath });
      } finally {
        allSpy.mockRestore();
      }
      db.init();

      expect(
        db.search({ query: 'Обсудили', scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId),
      ).toEqual(['s1']);
      expect(
        db.search({ query: '検索', scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId),
      ).toEqual(['s1']);
      expect(
        db.search({ query: 'legacyascii', scope: { type: 'global' }, maxResults: 10 }).map((hit) => hit.sessionId),
      ).toEqual(['s1']);

      const stats = db.getDeepIndexStats();
      expect(stats.deepChunkCount).toBe(1);
      expect(stats.deepEmbeddingCount).toBe(0);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
