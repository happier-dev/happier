import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';

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
  materializeNextPendingMessageSafely?: (opts?: {
    reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty;
  }) => Promise<MaterializeNextPendingResult>;
  popPendingMessage: () => Promise<boolean>;
  shouldAttemptPendingMaterialization?: () => boolean | Promise<boolean>;
  reconcilePendingQueueState?: (opts: { force: boolean }) => unknown | Promise<unknown>;
}>;

export type DrainPendingStoppedReason =
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
}>;

export type SessionProviderInputConsumer<Mode, Message> = Readonly<{
  waitForNextInput: (opts: { abortSignal: AbortSignal }) => Promise<MessageBatch<Mode, Message> | null>;
  drainPending: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
}>;
