import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { PendingQueueReconcileWhenEmpty } from '@/api/session/pendingQueueReadPolicy';

export type MessageBatch<Mode, Message> = {
  message: Message;
  mode: Mode;
  isolate: boolean;
  hash: string;
  /**
   * Owed-delivery watermark attribution (A3-HIGH-1): max server user-row seq among the queue
   * items consumed into this batch (null/absent when none carried one). Consumed by the
   * provider-acceptance seam to persist the delivered-watermark only for rows that actually
   * reached the provider.
   */
  maxUserMessageSeq?: number | null;
  /**
   * Local ids for the same consumed user rows. Provider-acceptance confirmation uses this when
   * the server seq is assigned by a later socket echo.
   */
  userMessageLocalIds?: readonly string[];
};

export type PendingMaterializationReconcileWhenEmpty = PendingQueueReconcileWhenEmpty;

export type PendingMaterializationResult = MaterializeNextPendingResult;

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
};

export type DrainPendingResult = {
  materialized: number;
  stoppedReason: DrainPendingStoppedReason;
};

export interface SessionProviderInputConsumer<Mode, Message> {
  waitForNextInput(opts: { abortSignal: AbortSignal }): Promise<MessageBatch<Mode, Message> | null>;
  drainPending(opts?: DrainPendingOptions): Promise<DrainPendingResult>;
}
