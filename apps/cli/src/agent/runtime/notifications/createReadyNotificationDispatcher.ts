import type { AccountSettings } from '@happier-dev/protocol';

import { emitReadyIfIdle } from '@/agent/runtime/emitReadyIfIdle';
import type { TurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshot';

import { getSessionNotificationTitle } from './sessionNotificationContext';
import { resolveReadyNotificationAssistantText } from './resolveReadyNotificationAssistantText';
import {
  enqueueReadySessionEventCommitted,
  sendReadyWithPushNotification,
} from './sendReadyWithPushNotification';

type ReadyNotificationSession = Readonly<{
  sessionId: string;
  enqueueSessionEventCommitted: (event: { type: 'ready' }) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
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
): () => Promise<void> {
  return async () => {
    if (!params.pushSender) {
      await enqueueReadySessionEventCommitted(params.session);
      return;
    }

    const sendReadyWithPushNotificationImpl =
      params.sendReadyWithPushNotificationFn ?? sendReadyWithPushNotification;

    await sendReadyWithPushNotificationImpl({
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
): () => Promise<void> {
  const sendReady = createReadyNotificationDispatcher(params);
  let readySentForCurrentIdlePeriod = false;
  let lastWorkVersion = params.getWorkVersion?.();
  let idleGeneration = 0;

  let readyDispatchInFlight: Promise<void> | null = null;

  return async () => {
    const pending = params.getPending();
    const queueSize = params.getQueueSize();
    const shouldExit = params.shouldExit?.() === true;
    const workVersion = params.getWorkVersion?.();

    if (!Object.is(workVersion, lastWorkVersion)) {
      readySentForCurrentIdlePeriod = false;
      lastWorkVersion = workVersion;
      idleGeneration += 1;
    }

    if (pending || queueSize > 0) {
      readySentForCurrentIdlePeriod = false;
      idleGeneration += 1;
      return;
    }

    if (shouldExit || readySentForCurrentIdlePeriod) {
      return;
    }

    if (readyDispatchInFlight) {
      await readyDispatchInFlight;
      return;
    }

    const dispatchGeneration = idleGeneration;
    const dispatch = emitReadyIfIdle({
      pending,
      queueSize: () => queueSize,
      shouldExit,
      sendReady,
    });
    readyDispatchInFlight = dispatch.then((emitted) => {
      if (emitted && dispatchGeneration === idleGeneration) {
        readySentForCurrentIdlePeriod = true;
      }
    });
    try {
      await readyDispatchInFlight;
    } finally {
      readyDispatchInFlight = null;
    }
  };
}
