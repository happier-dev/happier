import type { SqliteDatabaseSync } from '../../persistence/sqliteSync';
import type {
  MemoryIndexQueueDbHandle,
  MemorySessionIndexStateUpdate,
  MemoryWorkerRunUpdate,
} from './memoryIndexQueueTypes';

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function intOrZero(value: unknown): number {
  return nullableInt(value) ?? 0;
}

export function ensureMemoryIndexQueueSchema(db: SqliteDatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_session_index_state (
      sessionId TEXT PRIMARY KEY,
      selectedByBackfillPolicy TEXT,
      coveragePolicyJson TEXT NOT NULL,
      status TEXT NOT NULL,
      queuedReason TEXT,
      lastQueuedAtMs INTEGER,
      lastStartedAtMs INTEGER,
      lastSuccessAtMs INTEGER,
      lastAttemptAtMs INTEGER,
      lastCompletedAtMs INTEGER,
      lastErrorAtMs INTEGER,
      lastErrorCode TEXT,
      lastErrorMessage TEXT,
      consecutiveFailures INTEGER NOT NULL DEFAULT 0,
      nextEligibleAtMs INTEGER NOT NULL DEFAULT 0,
      lastObservedSeq INTEGER NOT NULL DEFAULT 0,
      lastScannedSeq INTEGER NOT NULL DEFAULT 0,
      lastSemanticSeq INTEGER NOT NULL DEFAULT 0,
      lastHintedSeq INTEGER NOT NULL DEFAULT 0,
      lastDeepIndexedSeq INTEGER NOT NULL DEFAULT 0,
      rawRowsFetched INTEGER NOT NULL DEFAULT 0,
      semanticRowsFound INTEGER NOT NULL DEFAULT 0,
      semanticRowsIndexedLight INTEGER NOT NULL DEFAULT 0,
      semanticRowsIndexedDeep INTEGER NOT NULL DEFAULT 0,
      lightShardCount INTEGER NOT NULL DEFAULT 0,
      deepChunkCount INTEGER NOT NULL DEFAULT 0,
      skippedReason TEXT,
      updatedAtMs INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_session_index_state_status_idx
    ON memory_session_index_state(status, updatedAtMs);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_worker_runs (
      runId TEXT PRIMARY KEY,
      startedAtMs INTEGER NOT NULL,
      finishedAtMs INTEGER,
      trigger TEXT NOT NULL,
      indexMode TEXT NOT NULL,
      sessionsConsidered INTEGER NOT NULL DEFAULT 0,
      sessionsProcessed INTEGER NOT NULL DEFAULT 0,
      sessionsIndexed INTEGER NOT NULL DEFAULT 0,
      sessionsSkipped INTEGER NOT NULL DEFAULT 0,
      sessionsFailed INTEGER NOT NULL DEFAULT 0,
      rawRowsFetched INTEGER NOT NULL DEFAULT 0,
      semanticRowsFound INTEGER NOT NULL DEFAULT 0,
      lightShardsCreated INTEGER NOT NULL DEFAULT 0,
      deepChunksCreated INTEGER NOT NULL DEFAULT 0,
      errorCode TEXT,
      errorMessage TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_worker_run_skip_reasons (
      runId TEXT NOT NULL,
      reason TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (runId, reason),
      FOREIGN KEY (runId) REFERENCES memory_worker_runs(runId) ON DELETE CASCADE
    );
  `);
}

export function createMemoryIndexQueueDb(db: SqliteDatabaseSync): MemoryIndexQueueDbHandle {
  const upsertSessionStateStmt = db.prepare(`
    INSERT INTO memory_session_index_state (
      sessionId, selectedByBackfillPolicy, coveragePolicyJson, status, queuedReason,
      lastQueuedAtMs, lastStartedAtMs, lastSuccessAtMs, lastAttemptAtMs, lastCompletedAtMs,
      lastErrorAtMs, lastErrorCode, lastErrorMessage, consecutiveFailures, nextEligibleAtMs,
      lastObservedSeq, lastScannedSeq, lastSemanticSeq, lastHintedSeq, lastDeepIndexedSeq,
      rawRowsFetched, semanticRowsFound, semanticRowsIndexedLight, semanticRowsIndexedDeep,
      lightShardCount, deepChunkCount, skippedReason, updatedAtMs
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(sessionId) DO UPDATE SET
      selectedByBackfillPolicy = excluded.selectedByBackfillPolicy,
      coveragePolicyJson = excluded.coveragePolicyJson,
      status = excluded.status,
      queuedReason = excluded.queuedReason,
      lastQueuedAtMs = excluded.lastQueuedAtMs,
      lastStartedAtMs = excluded.lastStartedAtMs,
      lastSuccessAtMs = excluded.lastSuccessAtMs,
      lastAttemptAtMs = excluded.lastAttemptAtMs,
      lastCompletedAtMs = excluded.lastCompletedAtMs,
      lastErrorAtMs = excluded.lastErrorAtMs,
      lastErrorCode = excluded.lastErrorCode,
      lastErrorMessage = excluded.lastErrorMessage,
      consecutiveFailures = excluded.consecutiveFailures,
      nextEligibleAtMs = excluded.nextEligibleAtMs,
      lastObservedSeq = excluded.lastObservedSeq,
      lastScannedSeq = excluded.lastScannedSeq,
      lastSemanticSeq = excluded.lastSemanticSeq,
      lastHintedSeq = excluded.lastHintedSeq,
      lastDeepIndexedSeq = excluded.lastDeepIndexedSeq,
      rawRowsFetched = excluded.rawRowsFetched,
      semanticRowsFound = excluded.semanticRowsFound,
      semanticRowsIndexedLight = excluded.semanticRowsIndexedLight,
      semanticRowsIndexedDeep = excluded.semanticRowsIndexedDeep,
      lightShardCount = excluded.lightShardCount,
      deepChunkCount = excluded.deepChunkCount,
      skippedReason = excluded.skippedReason,
      updatedAtMs = excluded.updatedAtMs;
  `);
  const upsertRunStmt = db.prepare(`
    INSERT INTO memory_worker_runs (
      runId, startedAtMs, finishedAtMs, trigger, indexMode, sessionsConsidered,
      sessionsProcessed, sessionsIndexed, sessionsSkipped, sessionsFailed, rawRowsFetched,
      semanticRowsFound, lightShardsCreated, deepChunksCreated, errorCode, errorMessage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(runId) DO UPDATE SET
      startedAtMs = excluded.startedAtMs,
      finishedAtMs = excluded.finishedAtMs,
      trigger = excluded.trigger,
      indexMode = excluded.indexMode,
      sessionsConsidered = excluded.sessionsConsidered,
      sessionsProcessed = excluded.sessionsProcessed,
      sessionsIndexed = excluded.sessionsIndexed,
      sessionsSkipped = excluded.sessionsSkipped,
      sessionsFailed = excluded.sessionsFailed,
      rawRowsFetched = excluded.rawRowsFetched,
      semanticRowsFound = excluded.semanticRowsFound,
      lightShardsCreated = excluded.lightShardsCreated,
      deepChunksCreated = excluded.deepChunksCreated,
      errorCode = excluded.errorCode,
      errorMessage = excluded.errorMessage;
  `);
  const deleteRunSkipReasonsStmt = db.prepare(`DELETE FROM memory_worker_run_skip_reasons WHERE runId = ?;`);
  const insertRunSkipReasonStmt = db.prepare(`
    INSERT INTO memory_worker_run_skip_reasons (runId, reason, count) VALUES (?, ?, ?);
  `);
  const aggregateStmt = db.prepare(`
    SELECT
      COUNT(*) AS selectedSessionCount,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queuedSessionCount,
      SUM(CASE WHEN status IN ('indexing_light', 'indexing_deep') THEN 1 ELSE 0 END) AS indexingSessionCount,
      SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexedSessionCount,
      SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END) AS emptySessionCount,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedSessionCount,
      SUM(CASE WHEN status IN ('waiting_idle', 'waiting_rate_limit', 'backing_off') THEN 1 ELSE 0 END) AS waitingSessionCount,
      MIN(CASE WHEN status = 'queued' THEN lastQueuedAtMs ELSE NULL END) AS oldestQueuedAtMs,
      SUM(rawRowsFetched) AS rawRowsFetched,
      SUM(semanticRowsFound) AS semanticRowsFound,
      SUM(semanticRowsIndexedLight) AS semanticRowsIndexedLight,
      SUM(semanticRowsIndexedDeep) AS semanticRowsIndexedDeep,
      SUM(lightShardCount) AS lightShardCount,
      SUM(deepChunkCount) AS deepChunkCount
    FROM memory_session_index_state;
  `);
  const latestRunStmt = db.prepare(`
    SELECT *
    FROM memory_worker_runs
    ORDER BY startedAtMs DESC
    LIMIT 1;
  `);
  const latestRunSkipReasonsStmt = db.prepare(`
    SELECT reason, count
    FROM memory_worker_run_skip_reasons
    WHERE runId = ?;
  `);

  return {
    recordMemorySessionIndexState: (state: MemorySessionIndexStateUpdate) => {
      const id = String(state.sessionId ?? '').trim();
      if (!id) return;
      upsertSessionStateStmt.run(
        id,
        nullableText(state.selectedByBackfillPolicy),
        nullableText(state.coveragePolicyJson) ?? '{"type":"full"}',
        String(state.status),
        nullableText(state.queuedReason),
        nullableInt(state.lastQueuedAtMs),
        nullableInt(state.lastStartedAtMs),
        nullableInt(state.lastSuccessAtMs),
        nullableInt(state.lastAttemptAtMs),
        nullableInt(state.lastCompletedAtMs),
        nullableInt(state.lastErrorAtMs),
        nullableText(state.lastErrorCode),
        nullableText(state.lastErrorMessage),
        intOrZero(state.consecutiveFailures),
        intOrZero(state.nextEligibleAtMs),
        intOrZero(state.lastObservedSeq),
        intOrZero(state.lastScannedSeq),
        intOrZero(state.lastSemanticSeq),
        intOrZero(state.lastHintedSeq),
        intOrZero(state.lastDeepIndexedSeq),
        intOrZero(state.rawRowsFetched),
        intOrZero(state.semanticRowsFound),
        intOrZero(state.semanticRowsIndexedLight),
        intOrZero(state.semanticRowsIndexedDeep),
        intOrZero(state.lightShardCount),
        intOrZero(state.deepChunkCount),
        nullableText(state.skippedReason),
        intOrZero(state.updatedAtMs),
      );
    },
    recordMemoryWorkerRun: (run: MemoryWorkerRunUpdate) => {
      const runId = String(run.runId ?? '').trim();
      if (!runId) return;
      upsertRunStmt.run(
        runId,
        intOrZero(run.startedAtMs),
        nullableInt(run.finishedAtMs),
        nullableText(run.trigger) ?? 'unknown',
        nullableText(run.indexMode) ?? 'unknown',
        intOrZero(run.sessionsConsidered),
        intOrZero(run.sessionsProcessed),
        intOrZero(run.sessionsIndexed),
        intOrZero(run.sessionsSkipped),
        intOrZero(run.sessionsFailed),
        intOrZero(run.rawRowsFetched),
        intOrZero(run.semanticRowsFound),
        intOrZero(run.lightShardsCreated),
        intOrZero(run.deepChunksCreated),
        nullableText(run.errorCode),
        nullableText(run.errorMessage),
      );
      deleteRunSkipReasonsStmt.run(runId);
      for (const [reason, count] of Object.entries(run.skipReasons ?? {})) {
        const normalizedReason = nullableText(reason);
        const normalizedCount = intOrZero(count);
        if (!normalizedReason || normalizedCount <= 0) continue;
        insertRunSkipReasonStmt.run(runId, normalizedReason, normalizedCount);
      }
    },
    getMemoryIndexQueueTelemetry: () => {
      const aggregate = aggregateStmt.get() as any;
      const latestRun = latestRunStmt.get() as any;
      const lastRun = latestRun
        ? {
            runId: String(latestRun.runId),
            startedAtMs: intOrZero(latestRun.startedAtMs),
            finishedAtMs: nullableInt(latestRun.finishedAtMs),
            trigger: String(latestRun.trigger ?? ''),
            indexMode: String(latestRun.indexMode ?? ''),
            sessionsConsidered: intOrZero(latestRun.sessionsConsidered),
            sessionsProcessed: intOrZero(latestRun.sessionsProcessed),
            sessionsIndexed: intOrZero(latestRun.sessionsIndexed),
            sessionsSkipped: intOrZero(latestRun.sessionsSkipped),
            sessionsFailed: intOrZero(latestRun.sessionsFailed),
            rawRowsFetched: intOrZero(latestRun.rawRowsFetched),
            semanticRowsFound: intOrZero(latestRun.semanticRowsFound),
            lightShardsCreated: intOrZero(latestRun.lightShardsCreated),
            deepChunksCreated: intOrZero(latestRun.deepChunksCreated),
            errorCode: nullableText(latestRun.errorCode),
            errorMessage: nullableText(latestRun.errorMessage),
            skipReasons: Object.fromEntries(
              (latestRunSkipReasonsStmt.all(String(latestRun.runId)) as any[])
                .map((row): [string, number] => [String(row.reason ?? ''), intOrZero(row.count)])
                .filter(([reason, count]) => reason.length > 0 && count > 0),
            ) as Record<string, number>,
          }
        : null;

      return {
        selectedSessionCount: intOrZero(aggregate?.selectedSessionCount),
        queuedSessionCount: intOrZero(aggregate?.queuedSessionCount),
        indexingSessionCount: intOrZero(aggregate?.indexingSessionCount),
        indexedSessionCount: intOrZero(aggregate?.indexedSessionCount),
        emptySessionCount: intOrZero(aggregate?.emptySessionCount),
        failedSessionCount: intOrZero(aggregate?.failedSessionCount),
        waitingSessionCount: intOrZero(aggregate?.waitingSessionCount),
        oldestQueuedAtMs: nullableInt(aggregate?.oldestQueuedAtMs),
        rawRowsFetched: intOrZero(aggregate?.rawRowsFetched),
        semanticRowsFound: intOrZero(aggregate?.semanticRowsFound),
        semanticRowsIndexedLight: intOrZero(aggregate?.semanticRowsIndexedLight),
        semanticRowsIndexedDeep: intOrZero(aggregate?.semanticRowsIndexedDeep),
        lightShardCount: intOrZero(aggregate?.lightShardCount),
        deepChunkCount: intOrZero(aggregate?.deepChunkCount),
        lastRun,
      };
    },
  };
}
