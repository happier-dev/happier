import { describe, expect, it } from 'vitest';

import {
  accountSettingsParse,
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  resolveNotificationChannelsV1FromAccountSettings,
} from './accountSettings.js';

describe('notificationChannelsV1', () => {
  it('derives the builtin expo push channel from legacy notification settings when explicit channels are missing', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: false,
        readyIncludeMessageText: false,
        permissionRequest: true,
        userActionRequest: false,
        foregroundBehavior: 'full',
      },
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: false,
          permissionRequest: true,
          userActionRequest: false,
        },
        readyIncludeMessageText: false,
      },
    ]);
  });

  it('prefers explicit notification channels over legacy notification settings', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: true,
            permissionRequest: false,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: 'webhook-primary',
        kind: 'webhook',
        enabled: true,
        url: 'https://hooks.example.test/happier',
        signingSecret: {
          _isSecretValue: true,
          value: 'webhook-secret',
        },
        topics: {
          ready: true,
          permissionRequest: false,
          userActionRequest: true,
        },
        readyIncludeMessageText: false,
      },
    ]);
  });

  it('treats an explicit empty notification channel list as authoritative', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([]);
  });

  it('falls back to the derived builtin expo channel when explicit notification channels are malformed', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: false,
        readyIncludeMessageText: false,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: '',
          kind: 'webhook',
          url: 'not-a-url',
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: false,
          permissionRequest: true,
          userActionRequest: true,
        },
        readyIncludeMessageText: false,
      },
    ]);
  });

  it('rejects non-http webhook URLs and falls back to the derived builtin expo channel', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          url: 'ftp://hooks.example.test/happier',
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: true,
          permissionRequest: true,
          userActionRequest: true,
        },
        readyIncludeMessageText: true,
      },
    ]);
  });
});
