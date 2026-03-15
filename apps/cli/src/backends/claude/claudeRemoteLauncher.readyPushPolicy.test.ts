import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';

import { createClaudeRemoteReadyHandler } from './claudeRemoteLauncher';

describe('createClaudeRemoteReadyHandler', () => {
  it('sends ready event but suppresses push when account settings disables ready pushes', () => {
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: false, permissionRequest: true },
    });

    const sendSessionEvent = vi.fn();
    const sendToAllDevices = vi.fn();

    const onReady = createClaudeRemoteReadyHandler({
      session: { sessionId: 's_1', sendSessionEvent },
      pushSender: { sendToAllDevices },
      logPrefix: '[remote]',
      waitingForCommandLabel: 'Claude',
      getPending: () => null,
      getQueueSize: () => 0,
      shouldSendPush: () => shouldSendReadyPushNotification(settings),
    });

    onReady();

    expect(sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(sendToAllDevices).not.toHaveBeenCalled();
  });

  it('sends push when idle and ready pushes are enabled', () => {
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });

    const sendSessionEvent = vi.fn();
    const sendToAllDevices = vi.fn();

    const onReady = createClaudeRemoteReadyHandler({
      session: { sessionId: 's_1', sendSessionEvent },
      pushSender: { sendToAllDevices },
      logPrefix: '[remote]',
      waitingForCommandLabel: 'Claude',
      getPending: () => null,
      getQueueSize: () => 0,
      shouldSendPush: () => shouldSendReadyPushNotification(settings),
    });

    onReady();

    expect(sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
    expect(sendToAllDevices).toHaveBeenCalledTimes(1);
  });

  it('does nothing when pending or queue is non-empty', () => {
    const sendSessionEvent = vi.fn();
    const sendToAllDevices = vi.fn();

    const onReady = createClaudeRemoteReadyHandler({
      session: { sessionId: 's_1', sendSessionEvent },
      pushSender: { sendToAllDevices },
      logPrefix: '[remote]',
      waitingForCommandLabel: 'Claude',
      getPending: () => ({ reason: 'pending' }),
      getQueueSize: () => 1,
    });

    onReady();

    expect(sendSessionEvent).not.toHaveBeenCalled();
    expect(sendToAllDevices).not.toHaveBeenCalled();
  });
});
