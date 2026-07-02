import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

export type DaemonServerWorkPurpose =
  | 'connectedServiceQuotaPersistence'
  | 'pendingMaterialization'
  | 'transcriptRecovery'
  | 'sessionEndReplay'
  | 'machineMaintenance'
  | 'accountMaintenance'
  | 'runtimeTelemetry';

export type DaemonServerWorkKind =
  | 'latestStateWrite'
  | 'mustDeliverMutation'
  | 'pollingReadCache'
  | 'livenessReadiness'
  | 'userInitiatedCommand';

export type DaemonServerWorkPriority = 'low' | 'normal' | 'high';

export type DaemonServerWorkCounter =
  | 'accepted'
  | 'coalesced'
  | 'suppressed'
  | 'written'
  | 'failed'
  | 'deferred'
  | 'retried';

export type DaemonServerWorkGateResult =
  | Readonly<{ status: 'open' }>
  | Readonly<{ status: 'deferred'; reason: string; retryAfterMs?: number }>
  | Readonly<{ status: 'suppressed'; reason: string }>;

export type DaemonServerWorkGate = () => DaemonServerWorkGateResult;

export type DaemonServerWorkErrorKind =
  | 'auth_failed'
  | 'unsupported'
  | 'generation_conflict'
  | 'rate_limited'
  | 'server_error'
  | 'dependency_unavailable'
  | 'timeout'
  | 'network'
  | 'client_error'
  | 'protocol_error';

export type DaemonServerWorkErrorClassification = Readonly<{
  kind: DaemonServerWorkErrorKind;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}>;

export type DaemonServerWorkOutcome =
  | Readonly<{ status: 'written' }>
  | Readonly<{ status: 'deferred'; reason: string; retryAfterMs?: number }>
  | Readonly<{ status: 'suppressed'; reason: string }>
  | Readonly<{ status: 'failed'; classification: DaemonServerWorkErrorClassification }>;

export type DaemonServerWorkLogger = Readonly<{
  debug?: (message: string, ...args: readonly unknown[]) => void;
  warn?: (message: string, ...args: readonly unknown[]) => void;
}>;

export type DaemonServerWorkBudget = Readonly<{
  run: <T>(metadata: Readonly<{ purpose: DaemonServerWorkPurpose | string }>, work: () => Promise<T>) => Promise<T>;
  getSnapshot: () => Readonly<{
    activeCount: number;
    queuedCount: number;
    maxConcurrentWrites: number;
  }>;
  awaitIdle: (timeoutMs: number) => Promise<Readonly<{ timedOut: boolean }>>;
}>;

export type DaemonServerWorkRequest<TPayload> = Readonly<{
  key: string;
  purpose: DaemonServerWorkPurpose | string;
  kind: DaemonServerWorkKind | string;
  priority?: DaemonServerWorkPriority;
  payload: TPayload;
  payloadBytes: number;
  run: (payload: TPayload) => Promise<void | DaemonServerWorkOutcome>;
}>;

export type DaemonServerWorkSnapshot = Readonly<{
  pendingKeyCount: number;
  pendingPayloadBytes: number;
  purposes: Record<string, Readonly<{ counters: Record<DaemonServerWorkCounter, number> }>>;
  keys: Record<string, Readonly<{
    timeSinceLastSuccessMs: number | null;
    backoffReason: string | null;
    nextEligibleAt: number | null;
  }>>;
}>;

export type DaemonServerWorkScheduler = Readonly<{
  enqueue: <TPayload>(work: DaemonServerWorkRequest<TPayload>) => Promise<DaemonServerWorkOutcome>;
  recordEvent: (event: Readonly<{
    purpose: DaemonServerWorkPurpose | string;
    key: string;
    type: DaemonServerWorkCounter;
    payloadBytes?: number;
  }>) => void;
  getSnapshot: () => DaemonServerWorkSnapshot;
  flushAll: (timeoutMs: number) => Promise<Readonly<{ timedOut: boolean }>>;
}>;

export type DaemonServerWorkSupervisorLike = Readonly<{
  getState: () => ManagedConnectionState;
}>;
