import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
  sendPermissionRequestPushNotificationAsync,
  sendPermissionRequestPushNotificationForActiveAccount,
} from './permissionRequestPush';

beforeEach(() => {
  resetActiveAccountSettingsSnapshotForTests();
});

describe('sendPermissionRequestPushNotificationAsync', () => {
  it('does not send when permissionRequest pushes are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    });

    await sendPermissionRequestPushNotificationAsync({
      pushSender: { sendToAllDevicesAsync },
      sessionId: 's1',
      sessionTitle: 'Review branch',
      agentDisplayName: 'Claude',
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
      sessionTitle: 'Review branch',
      agentDisplayName: 'Claude',
      permissionId: 'p1',
      toolName: 'Read',
      settings,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      expect.stringContaining('Claude asks permission to use Read'),
      expect.objectContaining({ sessionId: 's1', requestId: 'p1' }),
    );
  });

  it('notifies for an actual safe-yolo permission request instead of predicting Auto approval', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
    });

    sendPermissionRequestPushNotificationForActiveAccount({
      pushSender: { sendToAllDevicesAsync },
      sessionId: 's-auto',
      permissionId: 'p-auto',
      toolName: 'Read',
      permissionMode: 'safe-yolo',
    });

    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
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

  it('redacts non-Axios push errors before logging', async () => {
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const sendToAllDevicesAsync = async () => {
      throw new Error(
        'request failed for https://alice:SUPER_SECRET_PASSWORD@push.example.test/v1/send?token=secret Authorization: Bearer PUSH_SECRET',
      );
    };

    try {
      await expect(
        sendPermissionRequestPushNotificationAsync({
          pushSender: { sendToAllDevicesAsync },
          sessionId: 's1',
          permissionId: 'p1',
          toolName: 'Read',
          settings,
        }),
      ).resolves.toBe(false);

      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[activityNotifications] Failed to dispatch outbound notification'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        name: 'Error',
        message: 'request failed for https://push.example.test/v1/send Authorization: <redacted>',
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('PUSH_SECRET');
    } finally {
      debugSpy.mockRestore();
    }
  });
});
