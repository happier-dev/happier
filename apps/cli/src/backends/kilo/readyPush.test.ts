import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKiloReadyPushNotifier } from './readyPush';

describe('createKiloReadyPushNotifier', () => {
  const originalFlag = process.env.HAPPIER_KILO_READY_PUSH;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.HAPPIER_KILO_READY_PUSH;
    else process.env.HAPPIER_KILO_READY_PUSH = originalFlag;
  });

  it('does not send push notifications unless explicitly enabled', () => {
    delete process.env.HAPPIER_KILO_READY_PUSH;
    const sendToAllDevices = vi.fn();
    const notifier = createKiloReadyPushNotifier({
      api: { push: () => ({ sendToAllDevices }) },
      sessionId: 'session-1',
    });

    notifier.maybeSend();
    notifier.maybeSend();

    expect(sendToAllDevices).not.toHaveBeenCalled();
  });

  it('sends at most once per session when enabled', () => {
    process.env.HAPPIER_KILO_READY_PUSH = '1';
    const sendToAllDevices = vi.fn();
    const notifier = createKiloReadyPushNotifier({
      api: { push: () => ({ sendToAllDevices }) },
      sessionId: 'session-1',
    });

    notifier.maybeSend();
    notifier.maybeSend();

    expect(sendToAllDevices).toHaveBeenCalledTimes(1);
    expect(sendToAllDevices).toHaveBeenCalledWith("It's ready!", 'Kilo is waiting for your command', {
      sessionId: 'session-1',
    });
  });
});

