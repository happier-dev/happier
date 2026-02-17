import { openSqliteDatabaseSync, type SqliteDatabaseSync } from './sqliteSync';

export type MemorySearchScope =
  | Readonly<{ type: 'global' }>
  | Readonly<{ type: 'session'; sessionId: string }>;

export type SummaryShardSearchHit = Readonly<{
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  createdAtFromMs: number;
  createdAtToMs: number;
  summary: string;
  rank: number;
  score: number;
}>;

export type SummaryShardIndexDbHandle = Readonly<{
  init: () => void;
  insertSummaryShard: (args: Readonly<{
    sessionId: string;
    seqFrom: number;
    seqTo: number;
    createdAtFromMs: number;
    createdAtToMs: number;
    summary: string;
    keywords: ReadonlyArray<string>;
    entities: ReadonlyArray<string>;
    decisions: ReadonlyArray<string>;
  }>) => void;
  search: (args: Readonly<{ query: string; scope: MemorySearchScope; maxResults: number }>) => SummaryShardSearchHit[];
  getLatestShardSeqTo: (args: Readonly<{ sessionId: string }>) => number;
  getSessionCursors: (args: Readonly<{ sessionId: string; nowMs: number }>) => Readonly<{
    lastObservedSeq: number;
    lastHintedSeq: number;
    lastDeepIndexedSeq: number;
    consecutiveDeepFailures: number;
    nextDeepEligibleAtMs: number;
  }>;
  trySeedSessionCursorsIfMissing: (args: Readonly<{
    sessionId: string;
    nowMs: number;
    lastHintedSeq: number;
    lastDeepIndexedSeq: number;
  }>) => boolean;
  tryAcquireHintRunPermit: (args: Readonly<{ sessionId: string; nowMs: number; maxRunsPerHour: number }>) => boolean;
  markHintRunSuccess: (args: Readonly<{ sessionId: string; seqTo: number; nowMs: number }>) => void;
  markHintRunFailure: (args: Readonly<{ sessionId: string; nowMs: number; backoffBaseMs: number; backoffMaxMs: number }>) => void;
  enforceMaxShardsPerSession: (args: Readonly<{ sessionId: string; maxShardsPerSession: number }>) => void;
  markDeepIndexSuccess: (args: Readonly<{ sessionId: string; seqTo: number; nowMs: number }>) => void;
  markDeepIndexFailure: (args: Readonly<{ sessionId: string; nowMs: number; backoffBaseMs: number; backoffMaxMs: number }>) => void;
  deleteOldestSummaryShards: (args: Readonly<{ limit: number }>) => number;
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

const HINT_RUN_WINDOW_MS = 60 * 60 * 1000;

function ensureSchemaV2(db: SqliteDatabaseSync): void {
  db.exec(`PRAGMA journal_mode=WAL;`);
  db.exec(`PRAGMA synchronous=NORMAL;`);
  db.exec(`PRAGMA foreign_keys=ON;`);
  db.exec(`PRAGMA auto_vacuum=INCREMENTAL;`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_cursors (
      sessionId TEXT PRIMARY KEY,
      lastObservedSeq INTEGER NOT NULL DEFAULT 0,
      lastHintedSeq INTEGER NOT NULL DEFAULT 0,
      lastDeepIndexedSeq INTEGER NOT NULL DEFAULT 0,
      lastHintRunAtMs INTEGER NOT NULL DEFAULT 0,
      hintRunWindowStartMs INTEGER NOT NULL DEFAULT 0,
      hintRunWindowCount INTEGER NOT NULL DEFAULT 0,
      lastHintErrorAtMs INTEGER,
      lastDeepErrorAtMs INTEGER,
      consecutiveHintFailures INTEGER NOT NULL DEFAULT 0,
      consecutiveDeepFailures INTEGER NOT NULL DEFAULT 0,
      nextHintEligibleAtMs INTEGER NOT NULL DEFAULT 0,
      nextDeepEligibleAtMs INTEGER NOT NULL DEFAULT 0,
      updatedAtMs INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_shards (
      shardId INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      seqFrom INTEGER NOT NULL,
      seqTo INTEGER NOT NULL,
      createdAtFromMs INTEGER NOT NULL,
      createdAtToMs INTEGER NOT NULL,
      summary TEXT NOT NULL,
      keywordsText TEXT NOT NULL,
      entitiesText TEXT NOT NULL,
      decisionsText TEXT NOT NULL,
      UNIQUE (sessionId, seqFrom, seqTo)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS summary_shards_by_session_seqTo ON summary_shards(sessionId, seqTo);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_terms (
      term TEXT NOT NULL,
      shardId INTEGER NOT NULL,
      PRIMARY KEY (term, shardId),
      FOREIGN KEY (shardId) REFERENCES summary_shards(shardId) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS summary_terms_term_idx ON summary_terms(term);
  `);
}

function migrateV1ToV2(db: SqliteDatabaseSync): void {
  db.exec(`PRAGMA foreign_keys=ON;`);
  db.exec(`ALTER TABLE session_cursors ADD COLUMN lastHintRunAtMs INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE session_cursors ADD COLUMN hintRunWindowStartMs INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE session_cursors ADD COLUMN hintRunWindowCount INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`CREATE INDEX IF NOT EXISTS summary_shards_by_session_seqTo ON summary_shards(sessionId, seqTo);`);
}

function ensureSchema(db: SqliteDatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as any;
  const userVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (userVersion === 0) {
    ensureSchemaV2(db);
    db.exec('PRAGMA user_version=2');
    return;
  }
  if (userVersion === 1) {
    migrateV1ToV2(db);
    db.exec('PRAGMA user_version=2');
    return;
  }
  if (userVersion === 2) return;
  throw new Error(`Unsupported memory DB schema version: ${userVersion}`);
}

export function openSummaryShardIndexDb(args: Readonly<{ dbPath: string }>): SummaryShardIndexDbHandle {
  const db = openSqliteDatabaseSync(args.dbPath);
  ensureSchema(db);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO summary_shards (
      shardId,
      sessionId,
      seqFrom,
      seqTo,
      createdAtFromMs,
      createdAtToMs,
      summary,
      keywordsText,
      entitiesText,
      decisionsText
    ) VALUES (
      NULL,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `);
  const insertTermStmt = db.prepare(`INSERT OR IGNORE INTO summary_terms (term, shardId) VALUES (?, ?);`);
  const latestSeqToStmt = db.prepare(`SELECT MAX(seqTo) AS maxSeqTo FROM summary_shards WHERE sessionId = ?;`);

  const ensureCursorStmt = db.prepare(`INSERT OR IGNORE INTO session_cursors (sessionId, updatedAtMs) VALUES (?, ?);`);
  const getCursorStmt = db.prepare(`
    SELECT
      lastObservedSeq AS lastObservedSeq,
      lastHintedSeq AS lastHintedSeq,
      lastDeepIndexedSeq AS lastDeepIndexedSeq,
      lastHintRunAtMs AS lastHintRunAtMs,
      hintRunWindowStartMs AS hintRunWindowStartMs,
      hintRunWindowCount AS hintRunWindowCount,
      lastHintErrorAtMs AS lastHintErrorAtMs,
      lastDeepErrorAtMs AS lastDeepErrorAtMs,
      consecutiveHintFailures AS consecutiveHintFailures,
      consecutiveDeepFailures AS consecutiveDeepFailures,
      nextHintEligibleAtMs AS nextHintEligibleAtMs,
      nextDeepEligibleAtMs AS nextDeepEligibleAtMs,
      updatedAtMs AS updatedAtMs
    FROM session_cursors
    WHERE sessionId = ?;
  `);
  const seedCursorStmt = db.prepare(`
    UPDATE session_cursors
    SET
      lastObservedSeq = MAX(lastObservedSeq, ?),
      lastHintedSeq = MAX(lastHintedSeq, ?),
      lastDeepIndexedSeq = MAX(lastDeepIndexedSeq, ?),
      updatedAtMs = ?
    WHERE sessionId = ?;
  `);
  const getHintCursorStmt = db.prepare(`
    SELECT
      nextHintEligibleAtMs AS nextHintEligibleAtMs,
      lastHintRunAtMs AS lastHintRunAtMs,
      hintRunWindowStartMs AS hintRunWindowStartMs,
      hintRunWindowCount AS hintRunWindowCount,
      consecutiveHintFailures AS consecutiveHintFailures
    FROM session_cursors
    WHERE sessionId = ?;
  `);
  const updateHintPermitStmt = db.prepare(`
    UPDATE session_cursors
    SET
      lastHintRunAtMs = ?,
      hintRunWindowStartMs = ?,
      hintRunWindowCount = ?,
      updatedAtMs = ?
    WHERE sessionId = ?;
  `);
  const updateHintThrottleStmt = db.prepare(`
    UPDATE session_cursors
    SET
      nextHintEligibleAtMs = ?,
      updatedAtMs = ?
    WHERE sessionId = ?;
  `);
  const hintSuccessStmt = db.prepare(`
    UPDATE session_cursors
    SET
      lastHintedSeq = MAX(lastHintedSeq, ?),
      lastHintErrorAtMs = NULL,
      consecutiveHintFailures = 0,
      nextHintEligibleAtMs = 0,
      updatedAtMs = ?
    WHERE sessionId = ?;
  `);
  const hintFailureStmt = db.prepare(`
    UPDATE session_cursors
    SET
      lastHintErrorAtMs = ?,
      consecutiveHintFailures = consecutiveHintFailures + 1,
      nextHintEligibleAtMs = ?,
      updatedAtMs = ?
    WHERE sessionId = ?;
  `);

  const getDeepCursorStmt = db.prepare(`
    SELECT
      consecutiveDeepFailures AS consecutiveDeepFailures,
      nextDeepEligibleAtMs AS nextDeepEligibleAtMs
    FROM session_cursors
    WHERE sessionId = ?;
  `);
  const deepSuccessStmt = db.prepare(`
    UPDATE session_cursors
    SET
      lastDeepIndexedSeq = MAX(lastDeepIndexedSeq, ?),
      lastDeepErrorAtMs = NULL,
      consecutiveDeepFailures = 0,
      nextDeepEligibleAtMs = 0,
      updatedAtMs = ?
    WHERE sessionId = ?;
  `);
  const deepFailureStmt = db.prepare(`
    UPDATE session_cursors
    SET
      lastDeepErrorAtMs = ?,
      consecutiveDeepFailures = consecutiveDeepFailures + 1,
      nextDeepEligibleAtMs = ?,
      updatedAtMs = ?
    WHERE sessionId = ?;
  `);

  const evictStmt = db.prepare(`
    DELETE FROM summary_shards
    WHERE shardId IN (
      SELECT shardId
      FROM summary_shards
      WHERE sessionId = ?
      ORDER BY seqTo DESC
      LIMIT -1 OFFSET ?
    );
  `);
  const deleteOldestGlobalStmt = db.prepare(`
    DELETE FROM summary_shards
    WHERE shardId IN (
      SELECT shardId
      FROM summary_shards
      ORDER BY createdAtToMs ASC
      LIMIT ?
    );
  `);

  return {
    init: () => {
      // Schema is ensured at open time; keep init() for call-site symmetry.
    },
    insertSummaryShard: (shard) => {
      const keywordsText = shard.keywords.map((k) => String(k ?? '').trim()).filter(Boolean).join(' ');
      const entitiesText = shard.entities.map((k) => String(k ?? '').trim()).filter(Boolean).join(' ');
      const decisionsText = shard.decisions.map((k) => String(k ?? '').trim()).filter(Boolean).join(' ');
      const res = insertStmt.run(
        shard.sessionId,
        shard.seqFrom,
        shard.seqTo,
        shard.createdAtFromMs,
        shard.createdAtToMs,
        shard.summary,
        keywordsText,
        entitiesText,
        decisionsText,
      );
      if (!res || typeof (res as any).changes !== 'number' || (res as any).changes <= 0) {
        return;
      }
      const shardId = Number((res as any).lastInsertRowid);
      const terms = tokenize([shard.summary, keywordsText, entitiesText, decisionsText].join(' '));
      for (const term of terms) {
        insertTermStmt.run(term, shardId);
      }
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
          s.sessionId AS sessionId,
          s.seqFrom AS seqFrom,
          s.seqTo AS seqTo,
          s.createdAtFromMs AS createdAtFromMs,
          s.createdAtToMs AS createdAtToMs,
          s.summary AS summary,
          COUNT(*) AS hitCount
        FROM summary_terms t
          JOIN summary_shards s ON s.shardId = t.shardId
        WHERE t.term IN (${placeholders})
          ${scope.type === 'session' ? 'AND s.sessionId = ?' : ''}
        GROUP BY s.shardId
        ORDER BY hitCount DESC, s.createdAtToMs DESC
        LIMIT ?;
      `;
      const stmt = db.prepare(sql);
      const params: any[] = [...terms];
      if (scope.type === 'session') params.push(scope.sessionId);
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
          summary: String(row.summary ?? ''),
          rank,
          score,
        } satisfies SummaryShardSearchHit;
      });
    },
    getLatestShardSeqTo: ({ sessionId }) => {
      const row = latestSeqToStmt.get(String(sessionId ?? '').trim()) as any;
      const value = typeof row?.maxSeqTo === 'number' && Number.isFinite(row.maxSeqTo) ? Math.trunc(row.maxSeqTo) : 0;
      return Math.max(0, value);
    },
    getSessionCursors: ({ sessionId, nowMs }) => {
      const id = String(sessionId ?? '').trim();
      const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
      if (!id) {
        return {
          lastObservedSeq: 0,
          lastHintedSeq: 0,
          lastDeepIndexedSeq: 0,
          consecutiveDeepFailures: 0,
          nextDeepEligibleAtMs: 0,
        };
      }
      ensureCursorStmt.run(id, now);
      const row = getCursorStmt.get(id) as any;
      return {
        lastObservedSeq: typeof row?.lastObservedSeq === 'number' ? Math.max(0, Math.trunc(row.lastObservedSeq)) : 0,
        lastHintedSeq: typeof row?.lastHintedSeq === 'number' ? Math.max(0, Math.trunc(row.lastHintedSeq)) : 0,
        lastDeepIndexedSeq: typeof row?.lastDeepIndexedSeq === 'number' ? Math.max(0, Math.trunc(row.lastDeepIndexedSeq)) : 0,
        consecutiveDeepFailures:
          typeof row?.consecutiveDeepFailures === 'number' ? Math.max(0, Math.trunc(row.consecutiveDeepFailures)) : 0,
        nextDeepEligibleAtMs:
          typeof row?.nextDeepEligibleAtMs === 'number' ? Math.max(0, Math.trunc(row.nextDeepEligibleAtMs)) : 0,
      };
    },
    trySeedSessionCursorsIfMissing: ({ sessionId, nowMs, lastHintedSeq, lastDeepIndexedSeq }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return false;
      const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
      const hinted = Number.isFinite(lastHintedSeq) ? Math.max(0, Math.trunc(lastHintedSeq)) : 0;
      const deepSeq = Number.isFinite(lastDeepIndexedSeq) ? Math.max(0, Math.trunc(lastDeepIndexedSeq)) : 0;

      ensureCursorStmt.run(id, now);
      const row = getCursorStmt.get(id) as any;
      const isFresh =
        (typeof row?.lastObservedSeq !== 'number' || Math.trunc(row.lastObservedSeq) === 0) &&
        (typeof row?.lastHintedSeq !== 'number' || Math.trunc(row.lastHintedSeq) === 0) &&
        (typeof row?.lastDeepIndexedSeq !== 'number' || Math.trunc(row.lastDeepIndexedSeq) === 0) &&
        (typeof row?.lastHintRunAtMs !== 'number' || Math.trunc(row.lastHintRunAtMs) === 0) &&
        (typeof row?.hintRunWindowCount !== 'number' || Math.trunc(row.hintRunWindowCount) === 0) &&
        (typeof row?.consecutiveHintFailures !== 'number' || Math.trunc(row.consecutiveHintFailures) === 0) &&
        (typeof row?.consecutiveDeepFailures !== 'number' || Math.trunc(row.consecutiveDeepFailures) === 0) &&
        (typeof row?.nextHintEligibleAtMs !== 'number' || Math.trunc(row.nextHintEligibleAtMs) === 0) &&
        (typeof row?.nextDeepEligibleAtMs !== 'number' || Math.trunc(row.nextDeepEligibleAtMs) === 0);
      if (!isFresh) return false;

      const observed = Math.max(hinted, deepSeq);
      seedCursorStmt.run(observed, hinted, deepSeq, now, id);
      return true;
    },
    tryAcquireHintRunPermit: ({ sessionId, nowMs, maxRunsPerHour }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return false;
      const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
      const maxRuns = Number.isFinite(maxRunsPerHour) ? Math.max(1, Math.trunc(maxRunsPerHour)) : 1;

      ensureCursorStmt.run(id, now);
      const row = getHintCursorStmt.get(id) as any;
      const nextEligibleAtMs =
        typeof row?.nextHintEligibleAtMs === 'number' && Number.isFinite(row.nextHintEligibleAtMs)
          ? Math.trunc(row.nextHintEligibleAtMs)
          : 0;
      if (nextEligibleAtMs > now) return false;

      let windowStart =
        typeof row?.hintRunWindowStartMs === 'number' && Number.isFinite(row.hintRunWindowStartMs)
          ? Math.trunc(row.hintRunWindowStartMs)
          : 0;
      let windowCount =
        typeof row?.hintRunWindowCount === 'number' && Number.isFinite(row.hintRunWindowCount)
          ? Math.trunc(row.hintRunWindowCount)
          : 0;

      if (windowStart <= 0 || now - windowStart >= HINT_RUN_WINDOW_MS) {
        windowStart = now;
        windowCount = 0;
      }

      if (windowCount >= maxRuns) {
        updateHintThrottleStmt.run(windowStart + HINT_RUN_WINDOW_MS, now, id);
        return false;
      }

      updateHintPermitStmt.run(now, windowStart, windowCount + 1, now, id);
      return true;
    },
    markHintRunSuccess: ({ sessionId, seqTo, nowMs }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
      const seq = Number.isFinite(seqTo) ? Math.max(0, Math.trunc(seqTo)) : 0;
      ensureCursorStmt.run(id, now);
      hintSuccessStmt.run(seq, now, id);
    },
    markHintRunFailure: ({ sessionId, nowMs, backoffBaseMs, backoffMaxMs }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
      const base = Number.isFinite(backoffBaseMs) ? Math.max(0, Math.trunc(backoffBaseMs)) : 0;
      const max = Number.isFinite(backoffMaxMs) ? Math.max(0, Math.trunc(backoffMaxMs)) : 0;

      ensureCursorStmt.run(id, now);
      const row = getHintCursorStmt.get(id) as any;
      const failures =
        typeof row?.consecutiveHintFailures === 'number' && Number.isFinite(row.consecutiveHintFailures)
          ? Math.max(0, Math.trunc(row.consecutiveHintFailures))
          : 0;
      const nextFailures = failures + 1;

      let backoff = 0;
      if (base > 0) {
        const scaled = base * Math.pow(2, Math.max(0, nextFailures - 1));
        backoff = max > 0 ? Math.min(max, scaled) : scaled;
      }
      const nextEligibleAt = now + Math.max(0, Math.trunc(backoff));
      hintFailureStmt.run(now, nextEligibleAt, now, id);
    },
    enforceMaxShardsPerSession: ({ sessionId, maxShardsPerSession }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      const maxShards = Number.isFinite(maxShardsPerSession) ? Math.max(1, Math.trunc(maxShardsPerSession)) : 1;
      evictStmt.run(id, maxShards);
    },
    markDeepIndexSuccess: ({ sessionId, seqTo, nowMs }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
      const seq = Number.isFinite(seqTo) ? Math.max(0, Math.trunc(seqTo)) : 0;
      ensureCursorStmt.run(id, now);
      deepSuccessStmt.run(seq, now, id);
    },
    markDeepIndexFailure: ({ sessionId, nowMs, backoffBaseMs, backoffMaxMs }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      const now = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : 0;
      const base = Number.isFinite(backoffBaseMs) ? Math.max(0, Math.trunc(backoffBaseMs)) : 0;
      const max = Number.isFinite(backoffMaxMs) ? Math.max(0, Math.trunc(backoffMaxMs)) : 0;

      ensureCursorStmt.run(id, now);
      const row = getDeepCursorStmt.get(id) as any;
      const failures =
        typeof row?.consecutiveDeepFailures === 'number' && Number.isFinite(row.consecutiveDeepFailures)
          ? Math.max(0, Math.trunc(row.consecutiveDeepFailures))
          : 0;
      const nextFailures = failures + 1;

      let backoff = 0;
      if (base > 0) {
        const scaled = base * Math.pow(2, Math.max(0, nextFailures - 1));
        backoff = max > 0 ? Math.min(max, scaled) : scaled;
      }
      const nextEligibleAt = now + Math.max(0, Math.trunc(backoff));
      deepFailureStmt.run(now, nextEligibleAt, now, id);
    },
    deleteOldestSummaryShards: ({ limit }) => {
      const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
      if (n <= 0) return 0;
      const res = deleteOldestGlobalStmt.run(n) as any;
      return typeof res?.changes === 'number' && Number.isFinite(res.changes) ? Math.max(0, Math.trunc(res.changes)) : 0;
    },
    checkpointAndVacuum: () => {
      db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
      db.exec(`PRAGMA incremental_vacuum;`);
    },
    close: () => {
      db.close();
    },
  };
}
