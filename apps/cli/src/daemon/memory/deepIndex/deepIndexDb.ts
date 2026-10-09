import {
  openProtectedSqliteDatabaseSync,
  protectSqliteDatabaseFilesSync,
  resolveSqliteSupportedValueBatchSize,
  type SqliteDatabaseSync,
} from '../../persistence/sqliteSync';
import { tokenizeMemoryText } from '../tokenizeMemoryText';
import type { AccountArtifactRevision } from '../../../api/artifacts/accountArtifactStore';
import { MemoryDocumentSearchHitV1Schema, type MemoryDocumentSearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';

export type DeepIndexDocumentRef = Readonly<{ serverId: string; artifactId: string }>;
export type DeepIndexDocumentIdentity = Readonly<{
  ref: DeepIndexDocumentRef;
  revision: AccountArtifactRevision;
}>;
export type DeepIndexDocumentEntry = Readonly<{
  factId?: string;
  location: MemoryDocumentSearchHitV1['location'];
  text: string;
}>;
export type DeepIndexDocumentSearchHit = DeepIndexDocumentIdentity & DeepIndexDocumentEntry & Readonly<{
  rank: number;
  score: number;
}>;

export type DeepIndexSearchScope =
  | Readonly<{ type: 'global' }>
  | Readonly<{ type: 'session'; sessionId: string }>;

export type DeepIndexSearchHit = Readonly<{
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  createdAtFromMs: number;
  createdAtToMs: number;
  text: string;
  rank: number;
  score: number;
}>;

export type DeepIndexStats = Readonly<{
  deepChunkCount: number;
  deepEmbeddingCount: number;
  searchableSessionCount: number;
  latestIndexedMessageAtMs: number | null;
  searchableDocumentCount: number;
  deepDocumentEntryCount: number;
}>;

export type DeepIndexDbHandle = Readonly<{
  init: () => void;
  insertChunk: (args: Readonly<{
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    createdAtFromMs: number;
    createdAtToMs: number;
    text: string;
    policyKey?: string;
  }>) => void;
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
    keys: ReadonlyArray<Readonly<{ sessionId: string; seqFrom: number; seqTo: number }>>;
  }>) => Map<string, Float32Array>;
  listChunksWithoutEmbeddings: (args: Readonly<{
    sessionId: string;
    provider: string;
    modelId: string;
    limit: number;
  }>) => ReadonlyArray<Readonly<{
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    text: string;
  }>>;
  getDeepIndexStats: () => DeepIndexStats;
  replaceDocumentIndexData: (args: DeepIndexDocumentIdentity & Readonly<{ entries: readonly DeepIndexDocumentEntry[] }>) => void;
  /** The caller supplies current readable attachments, never cached access facts. */
  searchDocuments: (args: Readonly<{
    query: string;
    eligibleDocuments: readonly DeepIndexDocumentIdentity[];
    maxResults: number;
  }>) => DeepIndexDocumentSearchHit[];
  /** Requires the complete global attachment inventory, not one Session's scope. */
  pruneDocumentIndexData: (args: Readonly<{ eligibleDocuments: readonly DeepIndexDocumentIdentity[] }>) => number;
  /** Every Session id for which this deep index retains a chunk or embedding. */
  listIndexedSessionIds: () => readonly string[];
  hasSessionArtifactsOutsidePolicy: (args: Readonly<{ sessionId: string; policyKey: string }>) => boolean;
  pruneSessionArtifacts: (args: Readonly<{
    sessionId: string;
    policyKey: string;
    minSeq?: number;
    createdAtCutoffMs?: number;
  }>) => boolean;
  search: (args: Readonly<{
    query: string;
    scope: DeepIndexSearchScope;
    eligibleSessionIds?: readonly string[];
    maxResults: number;
  }>) => DeepIndexSearchHit[];
  /** Evicts chunks, then whole derived documents, within the one deep-index budget. */
  deleteOldestChunks: (args: Readonly<{ limit: number }>) => number;
  /**
   * Removes every deep derived row for one Session: chunks (with their
   * cascaded terms) and the embeddings keyed to those chunk ranges, which have
   * no foreign key and would otherwise keep consuming the deep-index budget.
   */
  deleteSessionIndexData: (args: Readonly<{ sessionId: string }>) => void;
  checkpointAndVacuum: () => void;
  close: () => void;
}>;

function normalizeQuery(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function intOrZero(value: unknown): number {
  return nullableInt(value) ?? 0;
}

function documentIdentityKey(document: DeepIndexDocumentIdentity): string {
  return JSON.stringify([document.ref.serverId, document.ref.artifactId, document.revision.headerVersion, document.revision.bodyVersion]);
}

function serializeDocumentLocation(location: DeepIndexDocumentEntry['location']): string {
  const parsed = MemoryDocumentSearchHitV1Schema.shape.location.parse(location);
  return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
}

function deserializeDocumentLocation(location: string): DeepIndexDocumentEntry['location'] {
  const legacy = MemoryDocumentSearchHitV1Schema.shape.location.safeParse(location);
  if (legacy.success) return legacy.data;
  return MemoryDocumentSearchHitV1Schema.shape.location.parse(JSON.parse(location));
}

type IndexedDocumentRow = Readonly<{
  documentId: number;
  serverId: string;
  artifactId: string;
  headerVersion: number;
  bodyVersion: number;
}>;

/** v2 rebuilt Unicode terms; v3 adds canonical memory-policy provenance. */
const DEEP_INDEX_SCHEMA_VERSION = 3;
function applyConnectionPragmas(db: SqliteDatabaseSync): void {
  db.exec(`PRAGMA journal_mode=WAL;`);
  db.exec(`PRAGMA synchronous=NORMAL;`);
  // The daemon worker and per-query search openers share this file; wait for a
  // writer (schema upgrade, eviction) instead of failing the caller outright.
  db.exec(`PRAGMA busy_timeout=5000;`);
  db.exec(`PRAGMA foreign_keys=ON;`);
  db.exec(`PRAGMA auto_vacuum=INCREMENTAL;`);
}

function ensureSchemaTables(db: SqliteDatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_chunks (
      chunkId INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      seqFrom INTEGER NOT NULL,
      seqTo INTEGER NOT NULL,
      createdAtFromMs INTEGER NOT NULL,
      createdAtToMs INTEGER NOT NULL,
      text TEXT NOT NULL,
      policyKey TEXT NOT NULL DEFAULT '',
      UNIQUE (sessionId, seqFrom, seqTo)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS message_chunks_by_session_seqTo ON message_chunks(sessionId, seqTo);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_terms (
      term TEXT NOT NULL,
      chunkId INTEGER NOT NULL,
      PRIMARY KEY (term, chunkId),
      FOREIGN KEY (chunkId) REFERENCES message_chunks(chunkId) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS chunk_terms_term_idx ON chunk_terms(term);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
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

  db.exec(`
    CREATE INDEX IF NOT EXISTS chunk_embeddings_provider_model_idx ON chunk_embeddings(provider, modelId);
  `);

  // Additive projections leave the existing Session schema/version readable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_documents (
      documentId INTEGER PRIMARY KEY AUTOINCREMENT,
      serverId TEXT NOT NULL,
      artifactId TEXT NOT NULL,
      headerVersion INTEGER NOT NULL,
      bodyVersion INTEGER NOT NULL,
      UNIQUE (serverId, artifactId)
    );
    CREATE TABLE IF NOT EXISTS document_entries (
      entryId INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId INTEGER NOT NULL,
      factId TEXT,
      location TEXT NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (documentId) REFERENCES indexed_documents(documentId) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS document_entries_by_document ON document_entries(documentId);
    CREATE TABLE IF NOT EXISTS document_terms (
      term TEXT NOT NULL,
      entryId INTEGER NOT NULL,
      PRIMARY KEY (term, entryId),
      FOREIGN KEY (entryId) REFERENCES document_entries(entryId) ON DELETE CASCADE
    );
  `);
}

/** Relax the development projection's old enum CHECK while preserving entry ids and term references. */
function migrateDocumentLocationStorage(db: SqliteDatabaseSync): void {
  // SQLite's untyped row boundary; only the projected field is inspected below.
  const readSchema = () => db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'document_entries';`).get() as Readonly<{ sql?: unknown }> | undefined;
  const hasLegacyCheck = () => {
    const sql = readSchema()?.sql;
    return typeof sql === 'string' && /CHECK\s*\(\s*location\s+IN\s*\(/i.test(sql);
  };
  if (!hasLegacyCheck()) return;
  // SQLite table replacement requires foreign keys off outside the transaction;
  // document_terms keeps referencing the final document_entries name and ids.
  db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    try {
      // Another opener may have completed the same upgrade while we waited.
      if (hasLegacyCheck()) {
        db.exec(`
          CREATE TABLE document_entries_topics (
            entryId INTEGER PRIMARY KEY AUTOINCREMENT,
            documentId INTEGER NOT NULL,
            factId TEXT,
            location TEXT NOT NULL,
            text TEXT NOT NULL,
            FOREIGN KEY (documentId) REFERENCES indexed_documents(documentId) ON DELETE CASCADE
          );
          INSERT INTO document_entries_topics (entryId, documentId, factId, location, text)
            SELECT entryId, documentId, factId, location, text FROM document_entries;
          DROP TABLE document_entries;
          ALTER TABLE document_entries_topics RENAME TO document_entries;
          CREATE INDEX document_entries_by_document ON document_entries(documentId);
        `);
      }
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
}

/** Embeddings have no foreign key to their chunk, so orphans are swept here. */
function deleteOrphanEmbeddings(db: SqliteDatabaseSync): void {
  db.exec(`
    DELETE FROM chunk_embeddings
    WHERE NOT EXISTS (
      SELECT 1
      FROM message_chunks c
      WHERE c.sessionId = chunk_embeddings.sessionId
        AND c.seqFrom = chunk_embeddings.seqFrom
        AND c.seqTo = chunk_embeddings.seqTo
    );
  `);
}

/**
 * Re-derives every term row from the chunk text the index already retains, so
 * an index written by the retired ASCII-only tokenizer becomes searchable
 * without discarding chunks, embeddings, or session progress cursors.
 */
function rebuildChunkTerms(db: SqliteDatabaseSync): void {
  const selectChunksPageStmt = db.prepare(`
    SELECT chunkId, text
    FROM message_chunks
    WHERE chunkId > ?
    ORDER BY chunkId ASC
    LIMIT ?;
  `);
  const insertTermStmt = db.prepare(`INSERT OR IGNORE INTO chunk_terms (term, chunkId) VALUES (?, ?);`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM chunk_terms;');
    let afterChunkId = 0;
    while (true) {
      const chunks = selectChunksPageStmt.all(afterChunkId, 250) as any[];
      if (chunks.length === 0) break;
      for (const chunk of chunks) {
        const chunkId = Number(chunk?.chunkId);
        if (!Number.isFinite(chunkId)) continue;
        for (const term of tokenizeMemoryText(String(chunk?.text ?? ''))) {
          insertTermStmt.run(term, chunkId);
        }
      }
      const nextAfterChunkId = Number(chunks.at(-1)?.chunkId);
      if (!Number.isFinite(nextAfterChunkId) || nextAfterChunkId <= afterChunkId) break;
      afterChunkId = nextAfterChunkId;
      if (chunks.length < 250) break;
    }
    deleteOrphanEmbeddings(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureSchema(db: SqliteDatabaseSync): void {
  applyConnectionPragmas(db);
  const versionRow = db.prepare('PRAGMA user_version').get() as any;
  const userVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (userVersion > DEEP_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported deep index DB schema version: ${userVersion}`);
  }

  ensureSchemaTables(db);
  migrateDocumentLocationStorage(db);
  if (userVersion > 0 && userVersion < 3) {
    const columns = db.prepare(`PRAGMA table_info(message_chunks)`).all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === 'policyKey')) {
      db.exec(`ALTER TABLE message_chunks ADD COLUMN policyKey TEXT NOT NULL DEFAULT '';`);
    }
  }
  if (userVersion === DEEP_INDEX_SCHEMA_VERSION) return;
  if (userVersion > 0 && userVersion < 2) rebuildChunkTerms(db);
  db.exec(`PRAGMA user_version=${DEEP_INDEX_SCHEMA_VERSION}`);
}

export function openDeepIndexDb(args: Readonly<{ dbPath: string }>): DeepIndexDbHandle {
  const db = openProtectedSqliteDatabaseSync(args.dbPath);
  ensureSchema(db);
  protectSqliteDatabaseFilesSync(args.dbPath);

  const insertChunkStmt = db.prepare(`
    INSERT OR IGNORE INTO message_chunks (
      chunkId,
      sessionId,
      seqFrom,
      seqTo,
      createdAtFromMs,
      createdAtToMs,
      text,
      policyKey
    ) VALUES (
      NULL,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?, ?
    );
  `);
  const insertTermStmt = db.prepare(`INSERT OR IGNORE INTO chunk_terms (term, chunkId) VALUES (?, ?);`);
  const selectOldestChunkKeysStmt = db.prepare(`
    SELECT chunkId, sessionId, seqFrom, seqTo
    FROM message_chunks
    ORDER BY createdAtToMs ASC
    LIMIT ?;
  `);
  const deleteChunkByIdStmt = db.prepare(`DELETE FROM message_chunks WHERE chunkId = ?;`);
  const deleteEmbeddingsForChunkStmt = db.prepare(`
    DELETE FROM chunk_embeddings
    WHERE sessionId = ? AND seqFrom = ? AND seqTo = ?;
  `);
  const deleteSessionChunksStmt = db.prepare(`DELETE FROM message_chunks WHERE sessionId = ?;`);
  const deleteSessionEmbeddingsStmt = db.prepare(`DELETE FROM chunk_embeddings WHERE sessionId = ?;`);
  const listIndexedSessionIdsStmt = db.prepare(`
    SELECT sessionId FROM message_chunks
    UNION
    SELECT sessionId FROM chunk_embeddings;
  `);

  const upsertEmbeddingStmt = db.prepare(`
    INSERT INTO chunk_embeddings (
      sessionId,
      seqFrom,
      seqTo,
      provider,
      modelId,
      dims,
      embedding,
      updatedAtMs
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    )
    ON CONFLICT(sessionId, seqFrom, seqTo, provider, modelId)
    DO UPDATE SET
      dims = excluded.dims,
      embedding = excluded.embedding,
      updatedAtMs = excluded.updatedAtMs;
  `);
  const listChunksWithoutEmbeddingsStmt = db.prepare(`
    SELECT c.sessionId, c.seqFrom, c.seqTo, c.text
    FROM message_chunks c
    LEFT JOIN chunk_embeddings e
      ON e.sessionId = c.sessionId
     AND e.seqFrom = c.seqFrom
     AND e.seqTo = c.seqTo
     AND e.provider = ?
     AND e.modelId = ?
    WHERE c.sessionId = ?
      AND e.sessionId IS NULL
    ORDER BY c.createdAtToMs ASC, c.seqTo ASC
    LIMIT ?;
  `);
  const deepIndexStatsStmt = db.prepare(`
    SELECT
      COUNT(*) AS deepChunkCount,
      COUNT(DISTINCT sessionId) AS searchableSessionCount,
      MAX(createdAtToMs) AS latestIndexedMessageAtMs
    FROM message_chunks;
  `);
  const deepEmbeddingStatsStmt = db.prepare(`SELECT COUNT(*) AS deepEmbeddingCount FROM chunk_embeddings;`);
  const selectPrunableChunksStmt = db.prepare(`
    SELECT chunkId, sessionId, seqFrom, seqTo FROM message_chunks
    WHERE sessionId = ?
      AND (policyKey <> ? OR seqFrom < ? OR createdAtFromMs < ?);
  `);
  const hasMismatchedPolicyStmt = db.prepare(`SELECT 1 FROM message_chunks WHERE sessionId = ? AND policyKey <> ? LIMIT 1;`);
  const deleteDocumentStmt = db.prepare(`DELETE FROM indexed_documents WHERE serverId = ? AND artifactId = ?;`);
  const deleteDocumentByIdStmt = db.prepare(`DELETE FROM indexed_documents WHERE documentId = ?;`);
  const insertDocumentStmt = db.prepare(`
    INSERT INTO indexed_documents (serverId, artifactId, headerVersion, bodyVersion) VALUES (?, ?, ?, ?);
  `);
  const insertDocumentEntryStmt = db.prepare(`
    INSERT INTO document_entries (documentId, factId, location, text) VALUES (?, ?, ?, ?);
  `);
  const insertDocumentTermStmt = db.prepare(`INSERT INTO document_terms (term, entryId) VALUES (?, ?);`);
  const listIndexedDocumentsStmt = db.prepare(`SELECT documentId, serverId, artifactId, headerVersion, bodyVersion FROM indexed_documents;`);
  const oldestDocumentsStmt = db.prepare(`SELECT documentId FROM indexed_documents ORDER BY documentId ASC LIMIT ?;`);
  const documentIndexStatsStmt = db.prepare(`
    SELECT (SELECT COUNT(DISTINCT documentId) FROM document_entries) AS searchableDocumentCount,
      (SELECT COUNT(*) FROM document_entries) AS deepDocumentEntryCount;
  `);

  const embeddingKey = (sessionId: string, seqFrom: number, seqTo: number): string => `${sessionId}:${seqFrom}-${seqTo}`;

  const encodeEmbeddingBlob = (embedding: Float32Array): Buffer => {
    const view = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    return Buffer.from(view);
  };

  const decodeEmbeddingBlob = (blob: Uint8Array, dims: number): Float32Array | null => {
    const expectedBytes = dims * 4;
    if (dims <= 0) return null;
    if (!blob || blob.length !== expectedBytes) return null;
    const bytes = Uint8Array.from(blob);
    return new Float32Array(bytes.buffer, bytes.byteOffset, dims);
  };

  return {
    init: () => {
      // Schema is ensured at open time.
    },
    replaceDocumentIndexData: ({ ref, revision, entries }) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteDocumentStmt.run(ref.serverId, ref.artifactId);
        // Both native SQLite adapters return this insertion result shape.
        const documentInsert = insertDocumentStmt.run(
          ref.serverId, ref.artifactId, revision.headerVersion, revision.bodyVersion,
        ) as Readonly<{ lastInsertRowid: number | bigint }>;
        const documentId = Number(documentInsert.lastInsertRowid);
        for (const entry of entries) {
          const text = entry.text.trim();
          if (!text) continue;
          const entryInsert = insertDocumentEntryStmt.run(documentId, entry.factId ?? null, serializeDocumentLocation(entry.location), text) as Readonly<{ lastInsertRowid: number | bigint }>;
          const entryId = Number(entryInsert.lastInsertRowid);
          for (const term of tokenizeMemoryText(text)) insertDocumentTermStmt.run(term, entryId);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    searchDocuments: ({ query, eligibleDocuments, maxResults }) => {
      const terms = tokenizeMemoryText(normalizeQuery(query));
      if (terms.length === 0 || eligibleDocuments.length === 0) return [];
      const limit = Math.max(1, Math.min(100, Math.floor(maxResults)));
      const documents = [...new Map(eligibleDocuments.map((document) => [documentIdentityKey(document), document])).values()];
      const batchSize = resolveSqliteSupportedValueBatchSize({ fixedParameterCount: terms.length + 1, parametersPerValue: 4 });
      type HitRow = IndexedDocumentRow & Readonly<{
        entryId: number; factId: string | null; location: string; text: string; hitCount: number;
      }>;
      const rows: HitRow[] = [];
      for (let offset = 0; offset < documents.length; offset += batchSize) {
        const batch = documents.slice(offset, offset + batchSize);
        const params: Array<string | number> = [];
        for (const document of batch) params.push(document.ref.serverId, document.ref.artifactId, document.revision.headerVersion, document.revision.bodyVersion);
        params.push(...terms, limit);
        rows.push(...db.prepare(`
          WITH eligible(serverId, artifactId, headerVersion, bodyVersion) AS (VALUES ${batch.map(() => '(?, ?, ?, ?)').join(',')})
          SELECT d.documentId, d.serverId, d.artifactId, d.headerVersion, d.bodyVersion,
            e.entryId, e.factId, e.location, e.text, COUNT(*) AS hitCount
          FROM eligible a JOIN indexed_documents d
            ON d.serverId = a.serverId AND d.artifactId = a.artifactId
              AND d.headerVersion = a.headerVersion AND d.bodyVersion = a.bodyVersion
          JOIN document_entries e ON e.documentId = d.documentId
          JOIN document_terms t ON t.entryId = e.entryId
          WHERE t.term IN (${terms.map(() => '?').join(',')})
          GROUP BY e.entryId ORDER BY hitCount DESC, e.entryId ASC LIMIT ?;
        `).all(...params) as HitRow[]);
      }
      rows.sort((left, right) => Number(right.hitCount) - Number(left.hitCount) || Number(left.entryId) - Number(right.entryId));
      return rows.slice(0, limit).map((row) => ({
        ref: { serverId: row.serverId, artifactId: row.artifactId },
        revision: { headerVersion: Number(row.headerVersion), bodyVersion: Number(row.bodyVersion) },
        ...(row.factId === null ? {} : { factId: row.factId }),
        location: deserializeDocumentLocation(row.location),
        text: row.text,
        rank: -Number(row.hitCount),
        score: Number(row.hitCount) / terms.length,
      }));
    },
    pruneDocumentIndexData: ({ eligibleDocuments }) => {
      const eligible = new Set(eligibleDocuments.map(documentIdentityKey));
      db.exec('BEGIN IMMEDIATE');
      try {
        let removed = 0;
        for (const row of listIndexedDocumentsStmt.all() as IndexedDocumentRow[]) {
          if (eligible.has(documentIdentityKey({
            ref: { serverId: row.serverId, artifactId: row.artifactId },
            revision: { headerVersion: Number(row.headerVersion), bodyVersion: Number(row.bodyVersion) },
          }))) continue;
          deleteDocumentByIdStmt.run(row.documentId);
          removed += 1;
        }
        db.exec('COMMIT');
        return removed;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    insertChunk: (chunk) => {
      const sessionId = String(chunk.sessionId ?? '').trim();
      if (!sessionId) return;
      const text = String(chunk.text ?? '').trim();
      if (!text) return;
      const res = insertChunkStmt.run(
        sessionId,
        Math.max(0, Math.trunc(chunk.seqFrom)),
        Math.max(0, Math.trunc(chunk.seqTo)),
        Math.max(0, Math.trunc(chunk.createdAtFromMs)),
        Math.max(0, Math.trunc(chunk.createdAtToMs)),
        text,
        String(chunk.policyKey ?? ''),
      );
      if (!res || typeof (res as any).changes !== 'number' || (res as any).changes <= 0) return;
      const chunkId = Number((res as any).lastInsertRowid);
      const terms = tokenizeMemoryText(text);
      for (const term of terms) {
        insertTermStmt.run(term, chunkId);
      }
    },
    upsertEmbedding: ({ sessionId, seqFrom, seqTo, provider, modelId, embedding, updatedAtMs }) => {
      const sid = String(sessionId ?? '').trim();
      const prov = String(provider ?? '').trim();
      const mid = String(modelId ?? '').trim();
      if (!sid || !prov || !mid) return;
      if (!(embedding instanceof Float32Array) || embedding.length === 0) return;
      const dims = embedding.length;
      const blob = encodeEmbeddingBlob(embedding);
      upsertEmbeddingStmt.run(
        sid,
        Math.max(0, Math.trunc(seqFrom)),
        Math.max(0, Math.trunc(seqTo)),
        prov,
        mid,
        dims,
        blob,
        Math.max(0, Math.trunc(updatedAtMs)),
      );
    },
    loadEmbeddings: ({ provider, modelId, keys }) => {
      const prov = String(provider ?? '').trim();
      const mid = String(modelId ?? '').trim();
      if (!prov || !mid) return new Map();
      if (!Array.isArray(keys) || keys.length === 0) return new Map();

      const clauses: string[] = [];
      const params: any[] = [prov, mid];
      for (const key of keys) {
        const sid = String(key?.sessionId ?? '').trim();
        if (!sid) continue;
        const from = Math.max(0, Math.trunc(key.seqFrom));
        const to = Math.max(0, Math.trunc(key.seqTo));
        clauses.push('(sessionId = ? AND seqFrom = ? AND seqTo = ?)');
        params.push(sid, from, to);
      }
      if (clauses.length === 0) return new Map();

      const sql = `
        SELECT sessionId, seqFrom, seqTo, dims, embedding
        FROM chunk_embeddings
        WHERE provider = ?
          AND modelId = ?
          AND (${clauses.join(' OR ')});
      `;
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as any[];

      const map = new Map<string, Float32Array>();
      for (const row of rows) {
        const sid = typeof row?.sessionId === 'string' ? row.sessionId : '';
        const from = typeof row?.seqFrom === 'number' ? row.seqFrom : Number(row?.seqFrom ?? NaN);
        const to = typeof row?.seqTo === 'number' ? row.seqTo : Number(row?.seqTo ?? NaN);
        const dims = typeof row?.dims === 'number' ? row.dims : Number(row?.dims ?? NaN);
        const blob = row?.embedding as Uint8Array | Buffer | null | undefined;
        if (!sid || !Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(dims) || !blob) continue;
        const embedding = decodeEmbeddingBlob(blob instanceof Uint8Array ? blob : Uint8Array.from(blob), Math.trunc(dims));
        if (!embedding) continue;
        map.set(embeddingKey(sid, Math.trunc(from), Math.trunc(to)), embedding);
      }
      return map;
    },
    listChunksWithoutEmbeddings: ({ sessionId, provider, modelId, limit }) => {
      const sid = String(sessionId ?? '').trim();
      const prov = String(provider ?? '').trim();
      const mid = String(modelId ?? '').trim();
      const cappedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
      if (!sid || !prov || !mid) return [];
      const rows = listChunksWithoutEmbeddingsStmt.all(prov, mid, sid, cappedLimit) as any[];
      return rows
        .map((row) => ({
          sessionId: typeof row?.sessionId === 'string' ? row.sessionId : '',
          seqFrom: typeof row?.seqFrom === 'number' ? row.seqFrom : Number(row?.seqFrom ?? NaN),
          seqTo: typeof row?.seqTo === 'number' ? row.seqTo : Number(row?.seqTo ?? NaN),
          text: typeof row?.text === 'string' ? row.text : '',
        }))
        .filter((row) => row.sessionId && Number.isFinite(row.seqFrom) && Number.isFinite(row.seqTo) && row.text.trim().length > 0);
    },
    getDeepIndexStats: () => {
      // Fixed SQL projections cross the untyped SQLite boundary; existing
      // numeric readers normalize the individual unknown values.
      const stats = deepIndexStatsStmt.get() as Readonly<{
        deepChunkCount?: unknown;
        searchableSessionCount?: unknown;
        latestIndexedMessageAtMs?: unknown;
      }> | undefined;
      const embeddingStats = deepEmbeddingStatsStmt.get() as Readonly<{ deepEmbeddingCount?: unknown }> | undefined;
      const documentStats = documentIndexStatsStmt.get() as Readonly<{
        searchableDocumentCount?: unknown;
        deepDocumentEntryCount?: unknown;
      }> | undefined;
      return {
        deepChunkCount: intOrZero(stats?.deepChunkCount),
        deepEmbeddingCount: intOrZero(embeddingStats?.deepEmbeddingCount),
        searchableSessionCount: intOrZero(stats?.searchableSessionCount),
        latestIndexedMessageAtMs: nullableInt(stats?.latestIndexedMessageAtMs),
        searchableDocumentCount: intOrZero(documentStats?.searchableDocumentCount),
        deepDocumentEntryCount: intOrZero(documentStats?.deepDocumentEntryCount),
      };
    },
    hasSessionArtifactsOutsidePolicy: ({ sessionId, policyKey }) => Boolean(
      hasMismatchedPolicyStmt.get(String(sessionId ?? '').trim(), String(policyKey ?? '')),
    ),
    pruneSessionArtifacts: ({ sessionId, policyKey, minSeq, createdAtCutoffMs }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return false;
      const doomed = selectPrunableChunksStmt.all(
        id,
        String(policyKey ?? ''),
        Math.max(0, Math.trunc(minSeq ?? 0)),
        Math.max(0, Math.trunc(createdAtCutoffMs ?? 0)),
      ) as Array<{ chunkId: number; sessionId: string; seqFrom: number; seqTo: number }>;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of doomed) {
          deleteEmbeddingsForChunkStmt.run(row.sessionId, row.seqFrom, row.seqTo);
          deleteChunkByIdStmt.run(row.chunkId);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return doomed.length > 0;
    },
    listIndexedSessionIds: () => {
      const rows = listIndexedSessionIdsStmt.all() as Array<{ sessionId?: unknown }>;
      const out: string[] = [];
      for (const row of rows) {
        const sessionId = typeof row.sessionId === 'string' ? row.sessionId.trim() : '';
        if (sessionId) out.push(sessionId);
      }
      return out;
    },
    search: ({ query, scope, eligibleSessionIds, maxResults }) => {
      const normalized = normalizeQuery(query);
      if (!normalized) return [];
      const limit = Math.max(1, Math.min(100, Math.floor(maxResults)));
      const terms = tokenizeMemoryText(normalized);
      if (terms.length === 0) return [];

      const eligibleIds = eligibleSessionIds === undefined
        ? undefined
        : [...new Set(eligibleSessionIds.map((id) => String(id).trim()).filter(Boolean))];
      if (eligibleIds?.length === 0) return [];

      const placeholders = terms.map(() => '?').join(',');
      const sessionIdBatchSize = resolveSqliteSupportedValueBatchSize({
        // Every term, the optional exact-session scope, and LIMIT are bound in
        // addition to the variable eligible-Session collection.
        fixedParameterCount: terms.length + (scope.type === 'session' ? 1 : 0) + 1,
        parametersPerValue: 1,
      });
      const queryBatch = (sessionIds?: readonly string[]): any[] => {
        const eligibilityPlaceholders = sessionIds?.map(() => '?').join(',');
        const sql = `
          SELECT
            c.sessionId AS sessionId,
            c.seqFrom AS seqFrom,
            c.seqTo AS seqTo,
            c.createdAtFromMs AS createdAtFromMs,
            c.createdAtToMs AS createdAtToMs,
            c.text AS text,
            COUNT(*) AS hitCount
          FROM chunk_terms t
            JOIN message_chunks c ON c.chunkId = t.chunkId
          WHERE t.term IN (${placeholders})
            ${scope.type === 'session' ? 'AND c.sessionId = ?' : ''}
            ${eligibilityPlaceholders ? `AND c.sessionId IN (${eligibilityPlaceholders})` : ''}
          GROUP BY c.chunkId
          ORDER BY hitCount DESC, c.createdAtToMs DESC
          LIMIT ?;
        `;
        const params: any[] = [...terms];
        if (scope.type === 'session') params.push(String(scope.sessionId ?? '').trim());
        if (sessionIds) params.push(...sessionIds);
        params.push(limit);
        return db.prepare(sql).all(...params) as any[];
      };
      let rows: any[];
      if (eligibleIds) {
        rows = [];
        for (let offset = 0; offset < eligibleIds.length; offset += sessionIdBatchSize) {
          rows.push(...queryBatch(eligibleIds.slice(offset, offset + sessionIdBatchSize)));
        }
        rows.sort((left, right) => Number(right.hitCount) - Number(left.hitCount)
          || Number(right.createdAtToMs) - Number(left.createdAtToMs));
        rows = rows.slice(0, limit);
      } else {
        rows = queryBatch();
      }

      return rows.map((row) => {
        const hitCount = Number(row.hitCount ?? 0);
        const score = terms.length > 0 ? hitCount / terms.length : 0;
        const rank = hitCount > 0 ? -hitCount : 0;
        return {
          sessionId: String(row.sessionId),
          seqFrom: Number(row.seqFrom),
          seqTo: Number(row.seqTo),
          createdAtFromMs: Number(row.createdAtFromMs),
          createdAtToMs: Number(row.createdAtToMs),
          text: String(row.text ?? ''),
          rank,
          score,
        } satisfies DeepIndexSearchHit;
      });
    },
    deleteOldestChunks: ({ limit }) => {
      const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
      if (n <= 0) return 0;
      const doomed = (selectOldestChunkKeysStmt.all(n) as any[]).filter((row) => Number.isFinite(Number(row?.chunkId)));
      const doomedDocuments = oldestDocumentsStmt.all(n - doomed.length) as Array<{ documentId: number }>;
      if (doomed.length === 0 && doomedDocuments.length === 0) return 0;

      // Terms cascade from the chunk row, but embeddings are keyed by
      // (sessionId, seqFrom, seqTo) with no foreign key, so they are removed
      // in the same transaction: otherwise they keep consuming the deep-index
      // disk budget and would be reused for a later chunk re-indexed at the
      // same sequence range with different text.
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of doomed) {
          deleteEmbeddingsForChunkStmt.run(
            String(row.sessionId ?? ''),
            Math.max(0, Math.trunc(Number(row.seqFrom))),
            Math.max(0, Math.trunc(Number(row.seqTo))),
          );
          deleteChunkByIdStmt.run(Math.trunc(Number(row.chunkId)));
        }
        for (const document of doomedDocuments) deleteDocumentByIdStmt.run(document.documentId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return doomed.length + doomedDocuments.length;
    },
    deleteSessionIndexData: ({ sessionId }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteSessionEmbeddingsStmt.run(id);
        deleteSessionChunksStmt.run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    checkpointAndVacuum: () => {
      db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
      db.exec(`PRAGMA incremental_vacuum;`);
    },
    close: () => {
      try {
        db.close();
      } catch {
        // best-effort
      }
    },
  };
}
