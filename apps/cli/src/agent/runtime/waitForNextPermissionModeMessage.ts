import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { MessageBatch } from '@/agent/runtime/session/input/_types';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';

export async function waitForNextPermissionModeMessage<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  session: ApiSessionClient;
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
  pendingDrainMaxPopPerWake?: number;
}): Promise<MessageBatch<Mode, Message> | null> {
  const materializeNextPendingMessageSafely = opts.session.materializeNextPendingMessageSafely;
  return await createSessionProviderInputConsumer({
    messageQueue: opts.messageQueue,
    session: {
      waitForMetadataUpdate: (signal) => opts.session.waitForMetadataUpdate(signal),
      ...(materializeNextPendingMessageSafely
        ? { materializeNextPendingMessageSafely: (materializeOpts) => materializeNextPendingMessageSafely.call(opts.session, materializeOpts) }
        : {}),
      getMetadataSnapshot: () => opts.session.getMetadataSnapshot(),
      popPendingMessage: () => opts.session.popPendingMessage(),
      shouldAttemptPendingMaterialization: () => opts.session.shouldAttemptPendingMaterialization?.() ?? true,
      reconcilePendingQueueState: async (reconcileOpts) => {
        await opts.session.reconcilePendingQueueState?.(reconcileOpts);
      },
    },
    beforePendingMaterialize: opts.beforePendingMaterialize,
    onMetadataUpdate: opts.onMetadataUpdate,
    reconcileWhenEmpty: 'skip',
    pendingDrainMaxPopPerWake: opts.pendingDrainMaxPopPerWake,
  }).waitForNextInput({ abortSignal: opts.abortSignal });
}
