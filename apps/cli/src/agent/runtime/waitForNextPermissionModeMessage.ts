import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type {
  MessageBatch,
  SessionProviderInputConsumer,
  SessionProviderInputConsumerSession,
} from '@/agent/runtime/session/input/_types';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { SessionPendingQueueDeliveryTiming } from '@happier-dev/protocol';
import { hostSubagentStore } from '@/session/subagents/hostSubagentStore';

export async function waitForNextPermissionModeMessage<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  abortSignal: AbortSignal;
  session: ApiSessionClient;
  beforeCollectQueuedBatch?: (() => void | Promise<void>) | null;
  readQueuedFollowWakeLocalIds?: () => readonly string[];
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
  pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  inputConsumer?: SessionProviderInputConsumer<Mode, Message>;
}): Promise<MessageBatch<Mode, Message> | null> {
  const inputConsumer = opts.inputConsumer ?? createSessionProviderInputConsumer({
    messageQueue: opts.messageQueue,
    session: createSessionProviderInputConsumerSessionAdapter(opts.session),
    reconcileWhenEmpty: 'skip',
    pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
    refreshBeforeQueuedBatch: false,
  });
  return await inputConsumer.waitForNextInput({
    abortSignal: opts.abortSignal,
    beforeCollectQueuedBatch: opts.beforeCollectQueuedBatch,
    readQueuedFollowWakeLocalIds: opts.readQueuedFollowWakeLocalIds,
    beforePendingMaterialize: opts.beforePendingMaterialize,
    onMetadataUpdate: opts.onMetadataUpdate,
  });
}

export function createSessionProviderInputConsumerSessionAdapter(
  session: ApiSessionClient,
  options: Pick<SessionProviderInputConsumerSession, 'readNativeRuntimeActivitySnapshot'> = {},
): SessionProviderInputConsumerSession {
  const materializeNextPendingMessageSafely = session.materializeNextPendingMessageSafely;
  return {
    ...options,
    waitForMetadataUpdate: (signal) => session.waitForMetadataUpdate(signal),
    armPendingClaim: (signal, timing, active, revision) => session.armPendingClaim?.(signal, timing, active, revision),
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
    getPendingMessageEditHoldIds: () => session.getPendingMessageEditHoldIds?.() ?? null,
    getAgentStateSnapshot: () => session.getAgentStateSnapshot(),
    readSubagentLiveWork: () => hostSubagentStore.readLiveWork(session.sessionId),
    subscribeSubagentLiveWork: listener => hostSubagentStore.subscribeLiveWork(session.sessionId, listener),
    getPendingQueueState: () => session.getPendingQueueState(),
    readPendingQueueStateForLiveWork: () => session.readPendingQueueStateForLiveWork(),
    shouldAttemptPendingMaterialization: () =>
      session.shouldAttemptPendingMaterialization?.() ?? true,
    hasPendingProviderInput: () => {
      const state = session.getPendingQueueState?.();
      return state?.known === true && state.pendingCount > 0;
    },
    ...(session.reconcilePendingProviderInputCustodyBeforeMaterialization
      ? {
          reconcilePendingProviderInputCustodyBeforeMaterialization: (opts) =>
            session.reconcilePendingProviderInputCustodyBeforeMaterialization(opts),
        }
      : {}),
    reconcilePendingQueueState: async (reconcileOpts) => {
      return await session.reconcilePendingQueueState?.(reconcileOpts);
    },
  };
}
