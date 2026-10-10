import {
  openProtectedSqliteDatabaseSync,
  protectSqliteDatabaseFilesSync,
  resolveSqliteSupportedValueBatchSize,
  type SqliteDatabaseSync,
} from '../persistence/sqliteSync';
import {
  createMemoryIndexQueueDb,
  ensureMemoryIndexQueueSchema,
} from './queue/memoryIndexQueueDb';
import type { MemoryIndexQueueDbHandle } from './queue/memoryIndexQueueTypes';
import { createMemoryFtsIndex, type MemoryFtsSearchFilter } from './memoryFtsIndex';

export type MemorySearchScope =
  | Readonly<{ type: 'global' }>
  | Readonly<{ type: 'session'; sessionId: string }>;

export type SummaryShardSearchHit = Readonly<{
  matchedQuery?: string;
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  createdAtFromMs: number;
  createdAtToMs: number;
  summary: string;
  rank: number;
  score: number;
}>;

export type SummaryIndexStats = Readonly<{
  lightShardCount: number;
  lightTermCount: number;
  searchableSessionCount: number;
  lastIndexedAtMs: number | null;
  latestIndexedMessageAtMs: number | null;
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
    policyKey?: string;
  }>) => void;
  search: (args: Readonly<{
    query: string;
    scope: MemorySearchScope;
    eligibleSessionIds?: readonly string[];
    maxResults: number;
    offset?: number;
    createdAfterMs?: number;
    createdBeforeMs?: number;
  }>) => SummaryShardSearchHit[];
  getSummaryIndexStats: () => SummaryIndexStats;
  getLatestShardSeqTo: (args: Readonly<{ sessionId: string }>) => number;
  /** Every Session id this index currently retains derived rows or progress for. */
  listIndexedSessionIds: () => readonly string[];
  pruneSessionArtifacts: (args: Readonly<{
    sessionId: string;
    policyKey: string;
    minSeq?: number;
    createdAtCutoffMs?: number;
  }>) => boolean;
  rewindSessionCursor: (args: Readonly<{ sessionId: string; lane: 'hints' | 'deep'; seq: number }>) => void;
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
  /**
   * Removes every tier-1 derived row for one Session: summary shards (and
   * their FTS rows), progress cursors, and queue/index state. Used when
   * a Session is deleted, its access is revoked, or it leaves the configured
   * eligibility; later re-admission must follow the then-current backfill
   * policy, so the cursor is deliberately not retained.
   */
  deleteSessionIndexData: (args: Readonly<{ sessionId: string }>) => void;
  checkpointAndVacuum: () => void;
  close: () => void;
}> & MemoryIndexQueueDbHandle;

function normalizeQuery(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

const HINT_RUN_WINDOW_MS = 60 * 60 * 1000;
function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function intOrZero(value: unknown): number {
  return nullableInt(value) ?? 0;
}

/** v6 replaces summary postings with weighted FTS5, preserving cursors and shards. */
const SUMMARY_INDEX_SCHEMA_VERSION = 6;

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
      policyKey TEXT NOT NULL DEFAULT '',
      UNIQUE (sessionId, seqFrom, seqTo)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS summary_shards_by_session_seqTo ON summary_shards(sessionId, seqTo);
  `);

}

function migrateV1ToV2(db: SqliteDatabaseSync): void {
  db.exec(`ALTER TABLE session_cursors ADD COLUMN lastHintRunAtMs INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE session_cursors ADD COLUMN hintRunWindowStartMs INTEGER NOT NULL DEFAULT 0;`);
  db.exec(`ALTER TABLE session_cursors ADD COLUMN hintRunWindowCount INTEGER NOT NULL DEFAULT 0;`);
}

/**
 * Re-derives FTS rows from shard text the index already retains, so
 * an index written by the retired postings tokenizer becomes searchable
 * without discarding shards or replaying session cursors from the server.
 */
function rebuildSummaryFts(db: SqliteDatabaseSync): void {
  const selectShardsPageStmt = db.prepare(`
    SELECT shardId, summary, keywordsText, entitiesText, decisionsText
    FROM summary_shards
    WHERE shardId > ?
    ORDER BY shardId ASC
    LIMIT ?;
  `);
  const fts = createMemoryFtsIndex(db, { table: 'summary_shards', id: 'shardId', fts: 'summary_fts' });
  db.exec('BEGIN IMMEDIATE');
  try {
    fts.clear();
    let afterShardId = 0;
    while (true) {
      const shards = selectShardsPageStmt.all(afterShardId, 250) as Array<{ shardId: number; summary: string; keywordsText: string; entitiesText: string; decisionsText: string }>;
      if (shards.length === 0) break;
      for (const shard of shards) {
        const shardId = Number(shard?.shardId);
        if (!Number.isFinite(shardId)) continue;
        fts.put(shardId, [shard.summary, shard.decisionsText].join(' '), [shard.keywordsText, shard.entitiesText].join(' '));
      }
      const nextAfterShardId = Number(shards.at(-1)?.shardId);
      if (!Number.isFinite(nextAfterShardId) || nextAfterShardId <= afterShardId) break;
      afterShardId = nextAfterShardId;
      if (shards.length < 250) break;
    }
    db.exec('DROP TABLE IF EXISTS summary_terms;');
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
  if (userVersion > SUMMARY_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported memory DB schema version: ${userVersion}`);
  }

  if (userVersion === 1) migrateV1ToV2(db);
  ensureSchemaTables(db);
  if (userVersion > 0 && userVersion < 5) {
    const columns = db.prepare(`PRAGMA table_info(summary_shards)`).all() as Array<{ name?: unknown }>;
    if (!columns.some((column) => column.name === 'policyKey')) {
      db.exec(`ALTER TABLE summary_shards ADD COLUMN policyKey TEXT NOT NULL DEFAULT '';`);
    }
  }
  ensureMemoryIndexQueueSchema(db);
  createMemoryFtsIndex(db, { table: 'summary_shards', id: 'shardId', fts: 'summary_fts' });
  if (userVersion === SUMMARY_INDEX_SCHEMA_VERSION) return;
  rebuildSummaryFts(db);
  db.exec(`PRAGMA user_version=${SUMMARY_INDEX_SCHEMA_VERSION}`);
}

export function openSummaryShardIndexDb(args: Readonly<{ dbPath: string }>): SummaryShardIndexDbHandle {
  const db = openProtectedSqliteDatabaseSync(args.dbPath);
  ensureSchema(db);
  protectSqliteDatabaseFilesSync(args.dbPath);

  const insertStmt = db.prepare(`
    INSERT INTO summary_shards (
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
      , policyKey
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
      ?, ?
    ) ON CONFLICT(sessionId, seqFrom, seqTo) DO UPDATE SET
      summary=excluded.summary, keywordsText=excluded.keywordsText,
      entitiesText=excluded.entitiesText, decisionsText=excluded.decisionsText,
      policyKey=excluded.policyKey, createdAtFromMs=excluded.createdAtFromMs, createdAtToMs=excluded.createdAtToMs;
  `);
  const summaryFts = createMemoryFtsIndex(db, { table: 'summary_shards', id: 'shardId', fts: 'summary_fts' });
  const findShardStmt = db.prepare('SELECT shardId FROM summary_shards WHERE sessionId=? AND seqFrom=? AND seqTo=?;');
  const latestSeqToStmt = db.prepare(`SELECT MAX(seqTo) AS maxSeqTo FROM summary_shards WHERE sessionId = ?;`);
  const summaryIndexStatsStmt = db.prepare(`
    SELECT
      COUNT(*) AS lightShardCount,
      COUNT(DISTINCT sessionId) AS searchableSessionCount,
      MAX(createdAtToMs) AS latestIndexedMessageAtMs
    FROM summary_shards;
  `);
  const summaryLastIndexedAtStmt = db.prepare(`SELECT MAX(updatedAtMs) AS lastIndexedAtMs FROM session_cursors;`);

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
  const listIndexedSessionIdsStmt = db.prepare(`
    SELECT sessionId FROM summary_shards
    UNION
    SELECT sessionId FROM session_cursors;
  `);
  const deleteSessionShardsStmt = db.prepare(`DELETE FROM summary_shards WHERE sessionId = ?;`);
  const deleteSessionCursorStmt = db.prepare(`DELETE FROM session_cursors WHERE sessionId = ?;`);
  const deleteSessionIndexStateStmt = db.prepare(`DELETE FROM memory_session_index_state WHERE sessionId = ?;`);
  const pruneSessionArtifactsStmt = db.prepare(`
    DELETE FROM summary_shards
    WHERE sessionId = ?
      AND (policyKey <> ? OR seqFrom < ? OR createdAtFromMs < ?);
  `);
  const rewindHintCursorStmt = db.prepare(`UPDATE session_cursors SET lastHintedSeq = MIN(lastHintedSeq, ?), updatedAtMs = ? WHERE sessionId = ?;`);
  const rewindDeepCursorStmt = db.prepare(`UPDATE session_cursors SET lastDeepIndexedSeq = MIN(lastDeepIndexedSeq, ?), updatedAtMs = ? WHERE sessionId = ?;`);
  const queueDb = createMemoryIndexQueueDb(db);

  return {
    init: () => {
      // Schema is ensured at open time; keep init() for call-site symmetry.
    },
    insertSummaryShard: (shard) => {
      const keywordsText = shard.keywords.map((k) => String(k ?? '').trim()).filter(Boolean).join(' ');
      const entitiesText = shard.entities.map((k) => String(k ?? '').trim()).filter(Boolean).join(' ');
      const decisionsText = shard.decisions.map((k) => String(k ?? '').trim()).filter(Boolean).join(' ');
      db.exec('BEGIN IMMEDIATE');
      try {
        insertStmt.run(
          shard.sessionId,
          shard.seqFrom,
          shard.seqTo,
          shard.createdAtFromMs,
          shard.createdAtToMs,
          shard.summary,
          keywordsText,
          entitiesText,
          decisionsText,
          String(shard.policyKey ?? ''),
        );
        const row = findShardStmt.get(shard.sessionId, shard.seqFrom, shard.seqTo) as { shardId: number };
        summaryFts.put(row.shardId, [shard.summary, decisionsText].join(' '), [keywordsText, entitiesText].join(' '));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    search: ({ query, scope, eligibleSessionIds, maxResults, offset = 0, createdAfterMs, createdBeforeMs }) => {
      const limit = Math.max(1, Math.floor(maxResults));
      const skip = Math.max(0, Math.trunc(offset));
      const eligibleIds = eligibleSessionIds === undefined ? undefined : [...new Set(eligibleSessionIds.map((id) => id.trim()).filter(Boolean))];
      if (eligibleIds?.length === 0) return [];
      type HitRow = { sessionId: string; seqFrom: number; seqTo: number; createdAtFromMs: number; createdAtToMs: number; summary: string; rank: number; shardId: number };
      const buildFilter = (sessionIds?: readonly string[]): MemoryFtsSearchFilter => {
        const filters: string[] = [];
        const params: Array<string | number> = [];
        if (scope.type === 'session') { filters.push('r.sessionId = ?'); params.push(scope.sessionId); }
        if (sessionIds) { filters.push(`r.sessionId IN (${sessionIds.map(() => '?').join(',')})`); params.push(...sessionIds); }
        if (createdAfterMs !== undefined) { filters.push('r.createdAtToMs >= ?'); params.push(createdAfterMs); }
        if (createdBeforeMs !== undefined) { filters.push('r.createdAtFromMs <= ?'); params.push(createdBeforeMs); }
        return { where: filters.join(' AND ') || '1', params };
      };
      const batchSize = resolveSqliteSupportedValueBatchSize({ fixedParameterCount: 5, parametersPerValue: 1 });
      const filters: MemoryFtsSearchFilter[] = [];
      if (eligibleIds) {
        for (let index = 0; index < eligibleIds.length; index += batchSize) filters.push(buildFilter(eligibleIds.slice(index, index + batchSize)));
      } else filters.push(buildFilter());
      const { match, matchedQuery } = summaryFts.query(normalizeQuery(query), filters);
      if (!match) return [];
      const queryBatch = (filter: MemoryFtsSearchFilter): HitRow[] => {
        return db.prepare(`
          SELECT r.*, bm25(summary_fts, 1.0, 4.0) AS rank
          FROM summary_fts JOIN summary_shards r ON r.shardId = summary_fts.rowid
          WHERE summary_fts MATCH ? AND ${filter.where}
          ORDER BY rank ASC, r.createdAtToMs DESC, r.shardId ASC LIMIT ?;
        `).all(match, ...filter.params, limit + skip) as HitRow[];
      };
      const rows: HitRow[] = [];
      for (const filter of filters) rows.push(...queryBatch(filter));
      return rows.sort((a, b) => a.rank - b.rank || b.createdAtToMs - a.createdAtToMs || a.shardId - b.shardId)
        .slice(skip, skip + limit).map((row) => ({
          sessionId: row.sessionId, seqFrom: row.seqFrom, seqTo: row.seqTo,
          createdAtFromMs: row.createdAtFromMs, createdAtToMs: row.createdAtToMs, summary: row.summary,
          rank: row.rank, score: 1 / (1 + Math.exp(row.rank)), matchedQuery,
        }));
    },
    getSummaryIndexStats: () => {
      const stats = summaryIndexStatsStmt.get() as any;
      const cursorStats = summaryLastIndexedAtStmt.get() as any;
      return {
        lightShardCount: intOrZero(stats?.lightShardCount),
        lightTermCount: summaryFts.termCount(),
        searchableSessionCount: intOrZero(stats?.searchableSessionCount),
        lastIndexedAtMs: nullableInt(cursorStats?.lastIndexedAtMs),
        latestIndexedMessageAtMs: nullableInt(stats?.latestIndexedMessageAtMs),
      };
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
    recordMemorySessionIndexState: queueDb.recordMemorySessionIndexState,
    getMemorySessionIndexStatus: queueDb.getMemorySessionIndexStatus,
    recordMemoryWorkerRun: queueDb.recordMemoryWorkerRun,
    getMemoryIndexQueueTelemetry: queueDb.getMemoryIndexQueueTelemetry,
    deleteOldestSummaryShards: ({ limit }) => {
      const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
      if (n <= 0) return 0;
      const res = deleteOldestGlobalStmt.run(n) as any;
      return typeof res?.changes === 'number' && Number.isFinite(res.changes) ? Math.max(0, Math.trunc(res.changes)) : 0;
    },
    listIndexedSessionIds: () => {
      const rows = listIndexedSessionIdsStmt.all() as Array<{ sessionId?: unknown }>;
      const out: string[] = [];
      for (const row of rows) {
        const id = typeof row?.sessionId === 'string' ? row.sessionId.trim() : '';
        if (id) out.push(id);
      }
      return out;
    },
    pruneSessionArtifacts: ({ sessionId, policyKey, minSeq, createdAtCutoffMs }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return false;
      const result = pruneSessionArtifactsStmt.run(
        id,
        String(policyKey ?? ''),
        Math.max(0, Math.trunc(minSeq ?? 0)),
        Math.max(0, Math.trunc(createdAtCutoffMs ?? 0)),
      );
      return Number((result as { changes?: unknown } | undefined)?.changes ?? 0) > 0;
    },
    rewindSessionCursor: ({ sessionId, lane, seq }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      const value = Math.max(0, Math.trunc(seq));
      (lane === 'hints' ? rewindHintCursorStmt : rewindDeepCursorStmt).run(value, Date.now(), id);
    },
    deleteSessionIndexData: ({ sessionId }) => {
      const id = String(sessionId ?? '').trim();
      if (!id) return;
      deleteSessionShardsStmt.run(id);
      deleteSessionCursorStmt.run(id);
      deleteSessionIndexStateStmt.run(id);
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
