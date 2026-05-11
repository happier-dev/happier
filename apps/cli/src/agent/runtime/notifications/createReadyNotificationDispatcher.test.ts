import { describe, expect, it, vi } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshotStore';
import type { sendReadyWithPushNotification } from './sendReadyWithPushNotification';

import { createIdleReadyNotificationDispatcher, createReadyNotificationDispatcher } from './createReadyNotificationDispatcher';

describe('createIdleReadyNotificationDispatcher', () => {
  it('passes current turn assistant text from the session snapshot to the ready sender', () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 1, startedAtMs: 100 });
    store.observe({ text: 'Ready for review', source: 'committed', seq: 2 });

    const sendReadyWithPushNotificationFn: typeof sendReadyWithPushNotification = vi.fn();
    const dispatchReady = createReadyNotificationDispatcher({
      session: {
        sessionId: 'session-1',
        sendSessionEvent: vi.fn(),
        getTurnAssistantTextSnapshotStore: () => store,
      },
      pushSender: { sendToAllDevices: vi.fn() },
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      includeAssistantPreviewText: true,
      sendReadyWithPushNotificationFn,
    });

    dispatchReady();

    expect(sendReadyWithPushNotificationFn).toHaveBeenCalledWith(
      expect.objectContaining({ assistantPreviewText: 'Ready for review' }),
    );
  });

  it('emits ready once while the runtime remains idle and rearms after work is observed', () => {
    let pending: unknown = null;
    let queueSize = 0;
    const sendSessionEvent = vi.fn();

    const dispatchReady = createIdleReadyNotificationDispatcher({
      session: {
        sessionId: 'session-1',
        sendSessionEvent,
      },
      pushSender: null,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      getPending: () => pending,
      getQueueSize: () => queueSize,
    });

    dispatchReady();
    dispatchReady();

    expect(sendSessionEvent).toHaveBeenCalledTimes(1);

    queueSize = 1;
    dispatchReady();

    expect(sendSessionEvent).toHaveBeenCalledTimes(1);

    queueSize = 0;
    dispatchReady();

    expect(sendSessionEvent).toHaveBeenCalledTimes(2);

    pending = { id: 'turn-1' };
    dispatchReady();

    expect(sendSessionEvent).toHaveBeenCalledTimes(2);

    pending = null;
    dispatchReady();

    expect(sendSessionEvent).toHaveBeenCalledTimes(3);
  });

  it('rearms when work completes between ready callbacks', () => {
    let workVersion = 0;
    const sendSessionEvent = vi.fn();

    const dispatchReady = createIdleReadyNotificationDispatcher({
      session: {
        sessionId: 'session-1',
        sendSessionEvent,
      },
      pushSender: null,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      getPending: () => null,
      getQueueSize: () => 0,
      getWorkVersion: () => workVersion,
    });

    dispatchReady();
    dispatchReady();

    expect(sendSessionEvent).toHaveBeenCalledTimes(1);

    workVersion += 1;
    dispatchReady();

    expect(sendSessionEvent).toHaveBeenCalledTimes(2);
  });
});
