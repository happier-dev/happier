import type { AccountSettings } from '@happier-dev/protocol';

import { emitReadyIfIdle } from '@/agent/runtime/emitReadyIfIdle';
import type { TurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshot';

import { getSessionNotificationTitle } from './sessionNotificationContext';
import { resolveReadyNotificationAssistantText } from './resolveReadyNotificationAssistantText';
import { sendReadyWithPushNotification } from './sendReadyWithPushNotification';

type ReadyNotificationSession = Readonly<{
  sessionId: string;
  sendSessionEvent: (event: { type: 'ready' }) => void;
  getMetadataSnapshot?: () => unknown;
  getTurnAssistantTextSnapshotStore?: () => TurnAssistantTextSnapshotStore;
}>;

type ReadyNotificationPushSender = Parameters<typeof sendReadyWithPushNotification>[0]['pushSender'];

type ReadyNotificationDispatcherParams = Readonly<{
  session: ReadyNotificationSession;
  pushSender: ReadyNotificationPushSender | null;
  waitingForCommandLabel: string;
  logPrefix: string;
  turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore | null;
  includeAssistantPreviewText?: boolean;
  shouldSendPush?: () => boolean;
  accountSettings?: AccountSettings | null;
  settingsSecretsReadKeys?: readonly Uint8Array[];
  sendReadyWithPushNotificationFn?: typeof sendReadyWithPushNotification;
}>;

type IdleReadyNotificationDispatcherParams = ReadyNotificationDispatcherParams & Readonly<{
  getPending: () => unknown;
  getQueueSize: () => number;
  getWorkVersion?: () => unknown;
  shouldExit?: () => boolean;
}>;

export function createReadyNotificationDispatcher(
  params: ReadyNotificationDispatcherParams,
): () => void {
  return () => {
    if (!params.pushSender) {
      params.session.sendSessionEvent({ type: 'ready' });
      return;
    }

    const sendReadyWithPushNotificationImpl =
      params.sendReadyWithPushNotificationFn ?? sendReadyWithPushNotification;

    sendReadyWithPushNotificationImpl({
      session: params.session,
      pushSender: params.pushSender,
      waitingForCommandLabel: params.waitingForCommandLabel,
      logPrefix: params.logPrefix,
      sessionTitle: getSessionNotificationTitle(
        typeof params.session.getMetadataSnapshot === 'function'
          ? () => params.session.getMetadataSnapshot?.()
          : null,
      ),
      assistantPreviewText: resolveReadyNotificationAssistantText({
        includeAssistantPreviewText: params.includeAssistantPreviewText,
        snapshotStore: params.turnAssistantTextSnapshotStore
          ?? params.session.getTurnAssistantTextSnapshotStore?.()
          ?? null,
      }),
      accountSettings: params.accountSettings ?? null,
      settingsSecretsReadKeys: params.settingsSecretsReadKeys,
      includeAssistantPreviewText: params.includeAssistantPreviewText,
      shouldSendPush: params.shouldSendPush,
    });
  };
}

export function createIdleReadyNotificationDispatcher(
  params: IdleReadyNotificationDispatcherParams,
): () => void {
  const sendReady = createReadyNotificationDispatcher(params);
  let readySentForCurrentIdlePeriod = false;
  let lastWorkVersion = params.getWorkVersion?.();

  return () => {
    const pending = params.getPending();
    const queueSize = params.getQueueSize();
    const shouldExit = params.shouldExit?.() === true;
    const workVersion = params.getWorkVersion?.();

    if (!Object.is(workVersion, lastWorkVersion)) {
      readySentForCurrentIdlePeriod = false;
      lastWorkVersion = workVersion;
    }

    if (pending || queueSize > 0) {
      readySentForCurrentIdlePeriod = false;
      return;
    }

    if (shouldExit || readySentForCurrentIdlePeriod) {
      return;
    }

    const emitted = emitReadyIfIdle({
      pending,
      queueSize: () => queueSize,
      shouldExit,
      sendReady,
    });

    if (emitted) {
      readySentForCurrentIdlePeriod = true;
    }
  };
}
