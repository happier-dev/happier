import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { sendPermissionRequestPushNotificationForActiveAccount } from './permissionRequestPush';

describe('sendPermissionRequestPushNotificationForActiveAccount', () => {
  it('does not send when permissionRequest pushes are disabled', () => {
    const sendToAllDevices = vi.fn();
    setActiveAccountSettingsSnapshot({
      source: 'cache',
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settings: accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
      }),
    });

    sendPermissionRequestPushNotificationForActiveAccount({
      pushSender: { sendToAllDevices },
      sessionId: 's1',
      permissionId: 'p1',
      toolName: 'Read',
    });

    expect(sendToAllDevices).not.toHaveBeenCalled();
  });

  it('sends when enabled', () => {
    const sendToAllDevices = vi.fn();
    setActiveAccountSettingsSnapshot({
      source: 'cache',
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settings: accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
      }),
    });

    sendPermissionRequestPushNotificationForActiveAccount({
      pushSender: { sendToAllDevices },
      sessionId: 's1',
      permissionId: 'p1',
      toolName: 'Read',
    });

    expect(sendToAllDevices).toHaveBeenCalledTimes(1);
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Permission Request',
      expect.stringContaining('Read'),
      expect.objectContaining({ sessionId: 's1', requestId: 'p1' }),
    );
  });

  it('does not throw when push sender throws', () => {
    setActiveAccountSettingsSnapshot({
      source: 'cache',
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settings: accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
      }),
    });

    const sendToAllDevices = () => {
      throw new Error('push down');
    };

    expect(() => {
      sendPermissionRequestPushNotificationForActiveAccount({
        pushSender: { sendToAllDevices },
        sessionId: 's1',
        permissionId: 'p1',
        toolName: 'Read',
      });
    }).not.toThrow();
  });
});
