import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { sendPermissionRequestPushNotificationAsync } from './permissionRequestPush';

describe('sendPermissionRequestPushNotificationAsync', () => {
  it('does not send when permissionRequest pushes are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    });

    await sendPermissionRequestPushNotificationAsync({
      pushSender: { sendToAllDevicesAsync },
      sessionId: 's1',
      permissionId: 'p1',
      toolName: 'Read',
      settings,
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('sends when enabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });

    await sendPermissionRequestPushNotificationAsync({
      pushSender: { sendToAllDevicesAsync },
      sessionId: 's1',
      permissionId: 'p1',
      toolName: 'Read',
      settings,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Permission Request',
      expect.stringContaining('Read'),
      expect.objectContaining({ sessionId: 's1', requestId: 'p1' }),
    );
  });

  it('does not throw when push sender throws', async () => {
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });

    const sendToAllDevicesAsync = async () => {
      throw new Error('push down');
    };

    await expect(
      sendPermissionRequestPushNotificationAsync({
        pushSender: { sendToAllDevicesAsync },
        sessionId: 's1',
        permissionId: 'p1',
        toolName: 'Read',
        settings,
      }),
    ).resolves.toBe(false);
  });
});
