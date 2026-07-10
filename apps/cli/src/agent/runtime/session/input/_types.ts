import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { PendingMaterializationActiveTurnPolicy } from '@/api/session/pendingMaterializationActiveTurnPolicy';
import type {
  PendingMaterializationDeliveryTiming,
  PendingQueueDeliveryBlockedReason,
} from '@/api/session/pendingQueueV2Transport';

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
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
  }) => Promise<MaterializeNextPendingResult>;
  popPendingMessage: () => Promise<boolean>;
  blockPendingMessageDelivery?: (params: Readonly<{
    localIds?: readonly string[] | null;
    reason: PendingQueueDeliveryBlockedReason;
  }>) => Promise<boolean>;
  shouldAttemptPendingMaterialization?: (opts?: {
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  }) => boolean | Promise<boolean>;
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
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  resolveActiveTurnDeliveryPolicy?: () => PendingMaterializationActiveTurnPolicy | undefined;
  deliveryTiming?: PendingMaterializationDeliveryTiming;
}>;

export type DrainPendingResult = Readonly<{
  materialized: number;
  stoppedReason: DrainPendingStoppedReason;
}>;

export type SessionProviderInputConsumer<Mode, Message> = Readonly<{
  waitForNextInput: (opts: { abortSignal: AbortSignal }) => Promise<MessageBatch<Mode, Message> | null>;
  drainPending: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
}>;
