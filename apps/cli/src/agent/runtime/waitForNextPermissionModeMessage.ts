import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type {
  MessageBatch,
  SessionProviderInputConsumer,
  SessionProviderInputConsumerSession,
} from '@/agent/runtime/session/input/_types';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { SessionPendingQueueDeliveryTiming } from '@happier-dev/protocol';

export async function waitForNextPermissionModeMessage<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  session: ApiSessionClient;
  beforeCollectQueuedBatch?: (() => void | Promise<void>) | null;
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
  pendingDrainMaxPopPerWake?: number;
  pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  inputConsumer?: SessionProviderInputConsumer<Mode, Message>;
}): Promise<MessageBatch<Mode, Message> | null> {
  const inputConsumer = opts.inputConsumer ?? createSessionProviderInputConsumer({
    messageQueue: opts.messageQueue,
    session: createSessionProviderInputConsumerSessionAdapter(opts.session),
    reconcileWhenEmpty: 'skip',
    pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
    refreshBeforeQueuedBatch: false,
    pendingDrainMaxPopPerWake: opts.pendingDrainMaxPopPerWake,
  });
  return await inputConsumer.waitForNextInput({
    abortSignal: opts.abortSignal,
    beforeCollectQueuedBatch: opts.beforeCollectQueuedBatch,
    beforePendingMaterialize: opts.beforePendingMaterialize,
    onMetadataUpdate: opts.onMetadataUpdate,
  });
}

export function createSessionProviderInputConsumerSessionAdapter(
  session: ApiSessionClient,
): SessionProviderInputConsumerSession {
  const materializeNextPendingMessageSafely = session.materializeNextPendingMessageSafely;
  return {
    waitForMetadataUpdate: (signal) => session.waitForMetadataUpdate(signal),
    ...(session.readRuntimeActivitySnapshotTail
      ? { readRuntimeActivitySnapshotTail: () => session.readRuntimeActivitySnapshotTail!() }
      : {}),
    ...(session.waitForRuntimeActivitySnapshotTailChange
      ? {
          waitForRuntimeActivitySnapshotTailChange: (sequence, signal) =>
            session.waitForRuntimeActivitySnapshotTailChange!(sequence, signal),
        }
      : {}),
    ...(materializeNextPendingMessageSafely
      ? { materializeNextPendingMessageSafely: (materializeOpts) => materializeNextPendingMessageSafely.call(session, materializeOpts) }
      : {}),
    getMetadataSnapshot: () => session.getMetadataSnapshot(),
    shouldAttemptPendingMaterialization: () =>
      session.shouldAttemptPendingMaterialization?.() ?? true,
    ...(session.reconcilePendingProviderInputCustodyBeforeMaterialization
      ? {
          reconcilePendingProviderInputCustodyBeforeMaterialization: () =>
            session.reconcilePendingProviderInputCustodyBeforeMaterialization(),
        }
      : {}),
    reconcilePendingQueueState: async (reconcileOpts) => {
      await session.reconcilePendingQueueState?.(reconcileOpts);
    },
  };
}
