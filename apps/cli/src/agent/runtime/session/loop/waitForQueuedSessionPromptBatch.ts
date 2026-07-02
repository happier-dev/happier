import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { MessageBatch } from '@/agent/runtime/session/input/_types';

export async function waitForQueuedSessionPromptBatch<Mode, Message>(params: Readonly<{
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  popPendingMessage: () => Promise<boolean>;
  materializeNextPendingMessageSafely?: (opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
  }) => Promise<MaterializeNextPendingResult>;
  shouldAttemptPendingMaterialization?: (() => boolean | Promise<boolean>) | null;
  reconcilePendingQueueState?: ((opts: { force: boolean }) => void | Promise<void>) | null;
  getMetadataSnapshot?: (() => unknown) | null;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
}>): Promise<MessageBatch<Mode, Message> | null> {
  return await createSessionProviderInputConsumer({
    messageQueue: params.messageQueue,
    session: {
      waitForMetadataUpdate: params.waitForMetadataUpdate,
      materializeNextPendingMessageSafely: params.materializeNextPendingMessageSafely,
      ...(params.getMetadataSnapshot ? { getMetadataSnapshot: params.getMetadataSnapshot } : {}),
      popPendingMessage: params.popPendingMessage,
      shouldAttemptPendingMaterialization: params.shouldAttemptPendingMaterialization ?? undefined,
      reconcilePendingQueueState: params.reconcilePendingQueueState ?? undefined,
    },
    onMetadataUpdate: params.onMetadataUpdate,
  }).waitForNextInput({ abortSignal: params.abortSignal });
}
