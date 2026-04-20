import { describe, expect, it, vi } from 'vitest';

const { createIdleReadyNotificationDispatcherMock, sharedReadyHandlerMock } = vi.hoisted(() => ({
  createIdleReadyNotificationDispatcherMock: vi.fn(),
  sharedReadyHandlerMock: vi.fn(),
}));

vi.mock('@/agent/runtime/notifications/createReadyNotificationDispatcher', () => ({
  createIdleReadyNotificationDispatcher: createIdleReadyNotificationDispatcherMock,
}));

import { createClaudeRemoteReadyHandler } from '../runtime/remote/createReadyHandler';

describe('createClaudeRemoteReadyHandler', () => {
  it('delegates live ready emission to the shared host notification helper', () => {
    createIdleReadyNotificationDispatcherMock.mockReturnValue(sharedReadyHandlerMock);

    const getPending = vi.fn(() => null);
    const getQueueSize = vi.fn(() => 0);
    const session = {
      sessionId: 'session-1',
      sendSessionEvent: vi.fn(),
    };
    const pushSender = {
      sendToAllDevices: vi.fn(),
    };

    const onReady = createClaudeRemoteReadyHandler({
      session,
      pushSender,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[remote]',
      getPending,
      getQueueSize,
    });

    expect(createIdleReadyNotificationDispatcherMock).toHaveBeenCalledWith(expect.objectContaining({
      session,
      pushSender,
      waitingForCommandLabel: 'Claude',
      logPrefix: '[remote]',
      getPending,
      getQueueSize,
    }));

    onReady();

    expect(sharedReadyHandlerMock).toHaveBeenCalledTimes(1);
  });
});
