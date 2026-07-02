export type MemorySessionIndexStatus =
  | 'queued'
  | 'indexing_light'
  | 'indexing_deep'
  | 'indexed'
  | 'empty'
  | 'waiting_idle'
  | 'waiting_rate_limit'
  | 'backing_off'
  | 'failed'
  | 'disabled';

export type MemorySessionIndexStateUpdate = Readonly<{
  sessionId: string;
  selectedByBackfillPolicy?: string | null;
  coveragePolicyJson?: string;
  status: MemorySessionIndexStatus;
  queuedReason?: string | null;
  lastQueuedAtMs?: number | null;
  lastStartedAtMs?: number | null;
  lastSuccessAtMs?: number | null;
  lastAttemptAtMs?: number | null;
  lastCompletedAtMs?: number | null;
  lastErrorAtMs?: number | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  consecutiveFailures?: number;
  nextEligibleAtMs?: number;
  lastObservedSeq?: number;
  lastScannedSeq?: number;
  lastSemanticSeq?: number;
  lastHintedSeq?: number;
  lastDeepIndexedSeq?: number;
  rawRowsFetched?: number;
  semanticRowsFound?: number;
  semanticRowsIndexedLight?: number;
  semanticRowsIndexedDeep?: number;
  lightShardCount?: number;
  deepChunkCount?: number;
  skippedReason?: string | null;
  updatedAtMs: number;
}>;

export type MemoryWorkerRunUpdate = Readonly<{
  runId: string;
  startedAtMs: number;
  finishedAtMs?: number | null;
  trigger: string;
  indexMode: string;
  sessionsConsidered?: number;
  sessionsProcessed?: number;
  sessionsIndexed?: number;
  sessionsSkipped?: number;
  sessionsFailed?: number;
  rawRowsFetched?: number;
  semanticRowsFound?: number;
  lightShardsCreated?: number;
  deepChunksCreated?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  skipReasons?: Readonly<Record<string, number>>;
}>;

export type MemoryIndexQueueTelemetry = Readonly<{
  selectedSessionCount: number;
  queuedSessionCount: number;
  indexingSessionCount: number;
  indexedSessionCount: number;
  emptySessionCount: number;
  failedSessionCount: number;
  waitingSessionCount: number;
  oldestQueuedAtMs: number | null;
  rawRowsFetched: number;
  semanticRowsFound: number;
  semanticRowsIndexedLight: number;
  semanticRowsIndexedDeep: number;
  lightShardCount: number;
  deepChunkCount: number;
  lastRun: Readonly<{
    runId: string;
    startedAtMs: number;
    finishedAtMs: number | null;
    trigger: string;
    indexMode: string;
    sessionsConsidered: number;
    sessionsProcessed: number;
    sessionsIndexed: number;
    sessionsSkipped: number;
    sessionsFailed: number;
    rawRowsFetched: number;
    semanticRowsFound: number;
    lightShardsCreated: number;
    deepChunksCreated: number;
    errorCode: string | null;
    errorMessage: string | null;
    skipReasons: Record<string, number>;
  }> | null;
}>;

export type MemoryIndexQueueDbHandle = Readonly<{
  recordMemorySessionIndexState: (args: MemorySessionIndexStateUpdate) => void;
  recordMemoryWorkerRun: (args: MemoryWorkerRunUpdate) => void;
  getMemoryIndexQueueTelemetry: () => MemoryIndexQueueTelemetry;
}>;
