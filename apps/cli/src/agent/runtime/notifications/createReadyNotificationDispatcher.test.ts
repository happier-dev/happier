import { describe, expect, it, vi } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshotStore';
import type { sendReadyWithPushNotification } from './sendReadyWithPushNotification';

import { createIdleReadyNotificationDispatcher, createReadyNotificationDispatcher } from './createReadyNotificationDispatcher';

describe('createIdleReadyNotificationDispatcher', () => {
  it('does not settle ready publication before durable transcript custody', async () => {
    let resolveAdmission!: (value: { persisted: boolean; delivered: boolean }) => void;
    const enqueueSessionEventCommitted = vi.fn(() => new Promise<{ persisted: boolean; delivered: boolean }>((resolve) => {
      resolveAdmission = resolve;
    }));
    const dispatchReady = createReadyNotificationDispatcher({
      session: {
        sessionId: 'session-1',
        enqueueSessionEventCommitted,
      },
      pushSender: null,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
    });

    let settled = false;
    const publication = Promise.resolve(dispatchReady()).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toBe(false);
    expect(enqueueSessionEventCommitted).toHaveBeenCalledWith({ type: 'ready' });

    resolveAdmission({ persisted: true, delivered: false });
    await publication;
    expect(settled).toBe(true);
  });

  it('does not consume idle dedupe when durable custody fails', async () => {
    const enqueueSessionEventCommitted = vi.fn()
      .mockResolvedValueOnce({ persisted: false, delivered: false })
      .mockResolvedValueOnce({ persisted: true, delivered: false });
    const dispatchReady = createIdleReadyNotificationDispatcher({
      session: { sessionId: 'session-1', enqueueSessionEventCommitted },
      pushSender: null,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      getPending: () => null,
      getQueueSize: () => 0,
    });

    await expect(dispatchReady()).rejects.toMatchObject({
      code: 'ready_transcript_custody_unavailable',
    });
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(2);
  });

  it('rearms when work is observed while ready admission is still pending', async () => {
    let workVersion = 0;
    let resolveFirstAdmission!: () => void;
    const enqueueSessionEventCommitted = vi.fn()
      .mockImplementationOnce(() => new Promise<{ persisted: boolean; delivered: boolean }>((resolve) => {
        resolveFirstAdmission = () => resolve({ persisted: true, delivered: false });
      }))
      .mockResolvedValue({ persisted: true, delivered: false });
    const dispatchReady = createIdleReadyNotificationDispatcher({
      session: { sessionId: 'session-1', enqueueSessionEventCommitted },
      pushSender: null,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      getPending: () => null,
      getQueueSize: () => 0,
      getWorkVersion: () => workVersion,
    });

    const firstReady = dispatchReady();
    await vi.waitFor(() => {
      expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(1);
    });
    workVersion += 1;
    const workObservation = dispatchReady();
    resolveFirstAdmission();
    await Promise.all([firstReady, workObservation]);
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(2);
  });

  it('passes current turn assistant text from the session snapshot to the ready sender', async () => {
    const store = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    store.beginTurn({ turnToken: 'turn-1', startSeqExclusive: 1, startedAtMs: 100 });
    store.observe({ text: 'Ready for review', source: 'committed', seq: 2 });

    const sendReadyWithPushNotificationFn: typeof sendReadyWithPushNotification = vi.fn();
    const dispatchReady = createReadyNotificationDispatcher({
      session: {
        sessionId: 'session-1',
        enqueueSessionEventCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
        getTurnAssistantTextSnapshotStore: () => store,
      },
      pushSender: { sendToAllDevices: vi.fn() },
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      includeAssistantPreviewText: true,
      sendReadyWithPushNotificationFn,
    });

    await dispatchReady();

    expect(sendReadyWithPushNotificationFn).toHaveBeenCalledWith(
      expect.objectContaining({ assistantPreviewText: 'Ready for review' }),
    );
  });

  it('emits ready once while the runtime remains idle and rearms after work is observed', async () => {
    let pending: unknown = null;
    let queueSize = 0;
    const enqueueSessionEventCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));

    const dispatchReady = createIdleReadyNotificationDispatcher({
      session: {
        sessionId: 'session-1',
        enqueueSessionEventCommitted,
      },
      pushSender: null,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      getPending: () => pending,
      getQueueSize: () => queueSize,
    });

    await dispatchReady();
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(1);

    queueSize = 1;
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(1);

    queueSize = 0;
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(2);

    pending = { id: 'turn-1' };
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(2);

    pending = null;
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(3);
  });

  it('rearms when work completes between ready callbacks', async () => {
    let workVersion = 0;
    const enqueueSessionEventCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));

    const dispatchReady = createIdleReadyNotificationDispatcher({
      session: {
        sessionId: 'session-1',
        enqueueSessionEventCommitted,
      },
      pushSender: null,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[runtime]',
      getPending: () => null,
      getQueueSize: () => 0,
      getWorkVersion: () => workVersion,
    });

    await dispatchReady();
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(1);

    workVersion += 1;
    await dispatchReady();

    expect(enqueueSessionEventCommitted).toHaveBeenCalledTimes(2);
  });
});
