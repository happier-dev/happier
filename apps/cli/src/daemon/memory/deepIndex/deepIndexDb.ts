import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '../sqliteSync';

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

export type DeepIndexDbHandle = Readonly<{
  init: () => void;
  insertChunk: (args: Readonly<{
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    createdAtFromMs: number;
    createdAtToMs: number;
    text: string;
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
  search: (args: Readonly<{ query: string; scope: DeepIndexSearchScope; maxResults: number }>) => DeepIndexSearchHit[];
  deleteOldestChunks: (args: Readonly<{ limit: number }>) => number;
  checkpointAndVacuum: () => void;
  close: () => void;
}>;

function normalizeQuery(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(text: string): string[] {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of normalized.split(' ')) {
    if (!part) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

function ensureSchemaV1(db: SqliteDatabaseSync): void {
  db.exec(`PRAGMA journal_mode=WAL;`);
  db.exec(`PRAGMA synchronous=NORMAL;`);
  db.exec(`PRAGMA foreign_keys=ON;`);
  db.exec(`PRAGMA auto_vacuum=INCREMENTAL;`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_chunks (
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
}

function ensureSchema(db: SqliteDatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as any;
  const userVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (userVersion === 0) {
    ensureSchemaV1(db);
    db.exec('PRAGMA user_version=1');
    return;
  }
  if (userVersion === 1) return;
  throw new Error(`Unsupported deep index DB schema version: ${userVersion}`);
}

export function openDeepIndexDb(args: Readonly<{ dbPath: string }>): DeepIndexDbHandle {
  const db = openSqliteDatabaseSync(args.dbPath);
  ensureSchema(db);

  const insertChunkStmt = db.prepare(`
    INSERT OR IGNORE INTO message_chunks (
      chunkId,
      sessionId,
      seqFrom,
      seqTo,
      createdAtFromMs,
      createdAtToMs,
      text
    ) VALUES (
      NULL,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `);
  const insertTermStmt = db.prepare(`INSERT OR IGNORE INTO chunk_terms (term, chunkId) VALUES (?, ?);`);
  const deleteOldestStmt = db.prepare(`
    DELETE FROM message_chunks
    WHERE chunkId IN (
      SELECT chunkId
      FROM message_chunks
      ORDER BY createdAtToMs ASC
      LIMIT ?
    );
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
      );
      if (!res || typeof (res as any).changes !== 'number' || (res as any).changes <= 0) return;
      const chunkId = Number((res as any).lastInsertRowid);
      const terms = tokenize(text);
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
    search: ({ query, scope, maxResults }) => {
      const normalized = normalizeQuery(query);
      if (!normalized) return [];
      const limit = Math.max(1, Math.min(100, Math.floor(maxResults)));
      const terms = tokenize(normalized);
      if (terms.length === 0) return [];

      const placeholders = terms.map(() => '?').join(',');
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
        GROUP BY c.chunkId
        ORDER BY hitCount DESC, c.createdAtToMs DESC
        LIMIT ?;
      `;
      const stmt = db.prepare(sql);
      const params: any[] = [...terms];
      if (scope.type === 'session') params.push(String(scope.sessionId ?? '').trim());
      params.push(limit);
      const rows = stmt.all(...params) as any[];

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
      const res = deleteOldestStmt.run(n) as any;
      return typeof res?.changes === 'number' && Number.isFinite(res.changes) ? Math.max(0, Math.trunc(res.changes)) : 0;
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
