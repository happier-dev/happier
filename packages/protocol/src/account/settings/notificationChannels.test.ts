import { describe, expect, it } from 'vitest';

import { BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID, hasConfiguredSecretStringValue } from './notificationChannels.js';
import { readLegacyNotificationChannelInventoryV1 } from './notificationChannelRecordV1.js';

describe('notificationChannelsV1 retained source', () => {
  it('treats a whitespace-only opaque secret as configured', () => {
    expect(hasConfiguredSecretStringValue({
      _isSecretValue: true,
      value: '   ',
    })).toBe(true);
  });

  it('derives the builtin expo push channel from legacy notification settings when explicit channels are missing', () => {
    const parsed = readLegacyNotificationChannelInventoryV1({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: false,
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: false,
        foregroundBehavior: 'full',
      },
    });

    expect(parsed).toEqual({ status: 'ready', channels: [
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: false,
          permissionRequest: true,
          userActionRequest: false,
          connectedServiceAccountSwitch: true,
          connectedServiceQuotaBlocked: true,
          connectedServiceQuotaRecovered: true,
          connectedServiceUsage: false,
        },
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
      },
    ] });
  });

  it('prefers explicit notification channels over legacy notification settings', () => {
    const parsed = readLegacyNotificationChannelInventoryV1({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
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
            connectedServiceAccountSwitch: false,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: true,
          },
          readyIncludeMessageText: false,
          requestIncludeMessageText: true,
        },
      ],
    });

    expect(parsed).toEqual({ status: 'ready', channels: [
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
          connectedServiceAccountSwitch: false,
          connectedServiceQuotaBlocked: false,
          connectedServiceQuotaRecovered: true,
          connectedServiceUsage: false,
        },
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
      },
    ] });
  });

  it('treats an explicit empty notification channel list as authoritative', () => {
    const parsed = readLegacyNotificationChannelInventoryV1({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [],
    });

    expect(parsed).toEqual({ status: 'ready', channels: [] });
  });

  it('refuses malformed retained channels without deriving a replacement builtin', () => {
    const parsed = readLegacyNotificationChannelInventoryV1({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: false,
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
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

    expect(parsed).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });

  it('refuses non-http retained webhook URLs without deriving a replacement builtin', () => {
    const parsed = readLegacyNotificationChannelInventoryV1({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
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

    expect(parsed).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
  });

  it('defaults quota recovered channel topics from quota blocked channel topics', () => {
    const parsed = readLegacyNotificationChannelInventoryV1({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
            connectedServiceQuotaBlocked: false,
          },
        },
      ],
    });

    expect(parsed.status).toBe('ready');
    if (parsed.status !== 'ready') throw new Error('Expected the valid retained channel inventory');
    expect(parsed.channels[0]?.topics).toEqual({
      ready: true,
      permissionRequest: true,
      userActionRequest: true,
      connectedServiceAccountSwitch: true,
      connectedServiceQuotaBlocked: false,
      connectedServiceQuotaRecovered: false,
      connectedServiceUsage: false,
    });
  });
});
