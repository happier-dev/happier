import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { PendingForegroundSteerability } from '@/api/session/pendingForegroundSteerability';
import type { PendingQueueReconcileWhenEmpty } from '@/api/session/pendingQueueReadPolicy';
import type { SessionPendingQueueDeliveryTiming } from '@happier-dev/protocol';

export type MessageBatch<Mode, Message> = {
  message: Message;
  mode: Mode;
  isolate: boolean;
  hash: string;
  /** Transcript/turn anchor only. Never provider-acceptance or settlement authority. */
  maxUserMessageSeq?: number | null;
  /** Opaque identities for consumed rows; provider outcomes require exactly one nonblank value. */
  userMessageLocalIds?: readonly string[];
  /** Exact current-vs-old custody marker; not a selectable materialization policy. */
  providerAcceptancePending?: boolean;
  providerPromptMeta?: unknown;
  pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
  pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
};

export type PendingMaterializationReconcileWhenEmpty = PendingQueueReconcileWhenEmpty;
export type { PendingForegroundSteerability };

export type PendingMaterializationResult = MaterializeNextPendingResult;
export type PendingQueueDeliveryTiming = SessionPendingQueueDeliveryTiming;

export type DrainPendingStoppedReason =
  | 'aborted'
  | 'auth_failure'
  | 'deferred'
  | 'drain_disallowed'
  | 'error'
  | 'materialization_blocked'
  | 'max_pop_per_wake'
  | 'no_pending';

export type DrainPendingOptions = {
  maxPopPerWake?: number | undefined;
  reason?: string | undefined;
  abortSignal?: AbortSignal | undefined;
  shouldContinue?: (() => boolean) | undefined;
  logPrefix?: string | undefined;
  activeTurnSteerability?: PendingForegroundSteerability | undefined;
  resolveActiveTurnSteerability?: (() => PendingForegroundSteerability) | undefined;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming | undefined;
  resolvePendingQueueDeliveryTiming?: (() => PendingQueueDeliveryTiming | undefined) | undefined;
};

export type DrainPendingResult = {
  materialized: number;
  stoppedReason: DrainPendingStoppedReason;
};

export type ActiveTurnPendingPumpOptions = Omit<DrainPendingOptions, 'abortSignal'> & {
  abortSignal: AbortSignal;
};

export interface SessionProviderInputConsumer<Mode, Message> {
  waitForNextInput(opts: {
    abortSignal: AbortSignal;
    /** A supplied wait callback overrides the construction callback; null disables it for this wait. */
    onMetadataUpdate?: ((abortSignal: AbortSignal) => void | Promise<void>) | null | undefined;
  }): Promise<MessageBatch<Mode, Message> | null>;
  runProviderInputDispatch<Value>(opts: Readonly<{
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>): Promise<Readonly<{ status: 'dispatched'; value: Value }> | Readonly<{ status: 'cancelled' }>>;
  closeProviderInputAdmissionAndWaitForDispatches(): Promise<void>;
  drainPending(opts?: DrainPendingOptions): Promise<DrainPendingResult>;
  pumpPendingWhileActive(opts: ActiveTurnPendingPumpOptions): Promise<void>;
}
