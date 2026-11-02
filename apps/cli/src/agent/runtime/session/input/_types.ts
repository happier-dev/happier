import type { HostRuntimeActivitySnapshot } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import type {
  MaterializeNextPendingOptions,
  MaterializeNextPendingResult,
  RuntimeActivitySnapshotTail,
} from '@/api/session/sessionClientPort';
import type { PendingQueueState } from '@/api/session/pendingQueueState';
import type { AgentState } from '@/api/types';

export type SessionInputLiveWork = Readonly<{
  session: 'active' | 'settled' | 'unknown';
  input: 'active' | 'settled' | 'unknown';
  /** Native provider work, excluding child Execution Runs; omission is unknown. */
  nativeRuntimeActivity?: 'active' | 'settled' | 'unknown';
  /** Older runners omit these fields; omission cannot prove settlement. */
  agents?: 'active' | 'settled' | 'unknown';
  attention?: 'active' | 'settled' | 'unknown';
  agentsActiveCount?: number;
  settledAt?: number;
}>;

export type MessageBatch<Mode, Message> = {
  message: Message;
  mode: Mode;
  isolate: boolean;
  hash: string;
};

export type PendingMaterializationReconcileWhenEmpty = 'force' | 'throttled' | 'skip';

export type SessionProviderInputConsumerSession = Readonly<{
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  getMetadataSnapshot?: () => unknown;
  getAgentStateSnapshot?: () => AgentState | null;
  readSubagentLiveWork?: () => Readonly<{ state: 'active' | 'settled' | 'unknown'; activeCount: number }>;
  subscribeSubagentLiveWork?: (listener: () => void) => () => void;
  readNativeRuntimeActivitySnapshot?: () => HostRuntimeActivitySnapshot;
  readRuntimeActivitySnapshotTail?: () => RuntimeActivitySnapshotTail;
  waitForRuntimeActivitySnapshotTailChange?: (
    sequence: number,
    abortSignal?: AbortSignal,
  ) => Promise<boolean>;
  materializeNextPendingMessageSafely?: (opts?: MaterializeNextPendingOptions) => Promise<MaterializeNextPendingResult>;
  /** Compatibility-only surface; the session-input owner never invokes it. */
  popPendingMessage?: () => Promise<boolean>;
  shouldAttemptPendingMaterialization?: () => boolean | Promise<boolean>;
  /** Synchronous observed Pending state at the context-only dispatch ordering point. */
  hasPendingProviderInput?: () => boolean;
  reconcilePendingProviderInputCustodyBeforeMaterialization?: () => Promise<boolean>;
  reconcilePendingQueueState?: (opts: { force: boolean }) => unknown | Promise<unknown>;
  readPendingQueueStateForLiveWork?: () => Promise<PendingQueueState>;
  /** Incumbent synchronous projection, used only to detect change edges. */
  getPendingQueueState?: () => PendingQueueState;
}>;

export type DrainPendingStoppedReason =
  | 'action_required'
  | 'aborted'
  | 'auth_failure'
  | 'deferred'
  | 'drain_disallowed'
  | 'error'
  | 'materialization_blocked'
  | 'max_pop_per_wake'
  | 'no_pending';

export type DrainPendingOptions = Readonly<{
  maxPopPerWake?: number;
  reason?: string;
  abortSignal?: AbortSignal;
  shouldContinue?: () => boolean | Promise<boolean>;
  logPrefix?: string;
}>;

export type DrainPendingResult = Readonly<{
  materialized: number;
  stoppedReason: DrainPendingStoppedReason;
  /** The materialization owner's delay for rejoining its retained claim. */
  retryAfterMs?: number;
}>;

export type ActiveTurnPendingPumpOptions = Omit<DrainPendingOptions, 'abortSignal'> & Readonly<{
  abortSignal: AbortSignal;
}>;

export type WaitForNextProviderInputOptions = Readonly<{
  abortSignal: AbortSignal;
  beforeCollectQueuedBatch?: (() => void | Promise<void>) | null;
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
}>;

export type SessionProviderInputConsumer<Mode, Message> = Readonly<{
  /** Re-evaluate Pending eligibility after the runtime's settled-turn boundary. */
  notifyInputReadinessChanged: () => void;
  readLiveWork: () => Promise<SessionInputLiveWork>;
  subscribeLiveWork: (listener: () => void) => () => void;
  /** The prompt-loop owner releases the batch after preparation/turn custody settles. */
  releaseInputBatch: () => void;
  waitForNextInput: (opts: WaitForNextProviderInputOptions) => Promise<MessageBatch<Mode, Message> | null>;
  deferContextOnlyInput: (batch: MessageBatch<Mode, Message>) => void;
  finalizeContextOnlyInput: (opts: Readonly<{
    batch: MessageBatch<Mode, Message>;
    abortSignal: AbortSignal;
    recheck: () => Promise<boolean>;
    /** Invoked synchronously after the queue's positive check; false means withdrawn. */
    commit: () => Promise<boolean>;
  }>) => Promise<'committed' | 'deferred' | 'withdrawn'>;
  waitUntilProviderInputAdmitted: (opts: { abortSignal: AbortSignal }) => Promise<boolean>;
  runProviderInputDispatch: <Value>(opts: Readonly<{
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>) => Promise<
    | Readonly<{ status: 'dispatched'; value: Value }>
    | Readonly<{ status: 'cancelled' }>
  >;
  runProviderInputDispatchFromAdmission: <Value>(opts: Readonly<{
    admission: Extract<
      ProviderInputActionRequiredDisposition,
      { reason: 'generation_pending' }
    >;
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>) => Promise<
    | Readonly<{ status: 'dispatched'; value: Value }>
    | Readonly<{ status: 'cancelled' }>
  >;
  drainPending: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
  pumpPendingWhileActive: (opts: ActiveTurnPendingPumpOptions) => Promise<void>;
  enforceProviderInputAdmission: (
    disposition: ProviderInputActionRequiredDisposition,
  ) => Promise<Readonly<{ status: 'enforced'; disposition: ProviderInputActionRequiredDisposition }>>;
  clearProviderInputAdmission: (scope: Readonly<{
    serviceId: string;
    groupId: string;
    epochId?: string;
  }>) => Promise<Readonly<{ status: 'cleared' | 'not_matched' }>>;
  readProviderInputAdmission: () => ProviderInputAdmissionDisposition;
}>;

export type ProviderInputActionRequiredDisposition = Readonly<{
  kind: 'action_required';
  reason: 'group_unavailable';
  serviceId: string;
  groupId: string;
}> | Readonly<{
  kind: 'action_required';
  reason: 'generation_pending';
  serviceId: string;
  groupId: string;
  epochId: string;
}>;

export type ProviderInputAdmissionDisposition =
  | Readonly<{ kind: 'admitted' }>
  | ProviderInputActionRequiredDisposition;
