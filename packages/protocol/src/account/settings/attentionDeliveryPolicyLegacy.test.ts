import { describe, expect, it } from 'vitest';

import {
  accountSettingsParse,
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
} from './accountSettings.js';

describe('attentionDeliveryPolicyV1 legacy backfill', () => {
  it('backfills expo push policy from legacy notificationsSettingsV1', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: false,
        ready: false,
        readyIncludeMessageText: false,
        permissionRequest: true,
        userActionRequest: false,
        foregroundBehavior: 'silent',
      },
    });

    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push).toMatchObject({
      enabled: false,
      previewBehavior: 'status_only',
      events: {
        ready: { enabled: false },
        permission_request: { enabled: true },
        user_action_request: { enabled: false },
      },
    });
    expect(parsed.attentionDeliveryPolicyV1.foregroundBehavior).toBe('silent');
  });

  it('falls back to legacy notification settings when an explicit policy is malformed', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: false,
        ready: false,
        readyIncludeMessageText: false,
        permissionRequest: true,
        userActionRequest: false,
        foregroundBehavior: 'silent',
      },
      attentionDeliveryPolicyV1: 'malformed-policy',
    });

    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push).toMatchObject({
      enabled: false,
      previewBehavior: 'status_only',
      events: {
        ready: { enabled: false },
        permission_request: { enabled: true },
        user_action_request: { enabled: false },
      },
    });
    expect(parsed.attentionDeliveryPolicyV1.foregroundBehavior).toBe('silent');
  });

  it('prefers explicit notificationChannelsV1 over legacy notificationsSettingsV1 for channel event toggles', () => {
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
        {
          v: 1,
          id: 'audit-webhook',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: {
            ready: true,
            permissionRequest: false,
            userActionRequest: true,
          },
        },
      ],
    });

    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push.events).toMatchObject({
      ready: { enabled: false },
      permission_request: { enabled: true },
      user_action_request: { enabled: false },
    });
    expect(parsed.attentionDeliveryPolicyV1.channels.webhook.events).toMatchObject({
      ready: { enabled: true },
      permission_request: { enabled: false },
      user_action_request: { enabled: true },
    });
  });

  it('backfills connected-service notification topic toggles into attention events', () => {
    const parsed = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
          kind: 'expo_push',
          enabled: true,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
            connectedServiceAccountSwitch: false,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: true,
          },
        },
      ],
    });

    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push.events).toMatchObject({
      connected_service_account_switch: { enabled: false },
      connected_service_quota_blocked: { enabled: false },
      connected_service_quota_recovered: { enabled: true },
    });
  });

  it('aggregates webhook channels instead of leaving the canonical webhook policy enabled after removal', () => {
    const withoutWebhooks = accountSettingsParse({
      notificationChannelsV1: [
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
        },
      ],
    });

    expect(withoutWebhooks.attentionDeliveryPolicyV1.channels.webhook.enabled).toBe(false);

    const withMixedWebhooks = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-disabled',
          kind: 'webhook',
          enabled: false,
          url: 'https://hooks.example.test/disabled',
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
        },
        {
          v: 1,
          id: 'webhook-permission-only',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/permission',
          topics: {
            ready: false,
            permissionRequest: true,
            userActionRequest: false,
          },
        },
        {
          v: 1,
          id: 'webhook-action-only',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/action',
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: true,
          },
        },
      ],
    });

    expect(withMixedWebhooks.attentionDeliveryPolicyV1.channels.webhook).toMatchObject({
      enabled: true,
      events: {
        ready: { enabled: false },
        permission_request: { enabled: true },
        user_action_request: { enabled: true },
      },
    });
  });

  it('treats an explicit webhook-only legacy channel list as disabling Expo push backfill', () => {
    const parsed = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/notify',
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
        },
      ],
    });

    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push.enabled).toBe(false);
    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push.events).toMatchObject({
      ready: { enabled: false },
      permission_request: { enabled: false },
      user_action_request: { enabled: false },
    });
    expect(parsed.attentionDeliveryPolicyV1.channels.webhook.enabled).toBe(true);
  });

  it('parses legacy camelCase topic ids inside explicit attention policy event maps', () => {
    const parsed = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        events: {
          permissionRequest: { enabled: false },
          userActionRequest: { enabled: false },
        },
        channels: {
          local_notification: {
            events: {
              permissionRequest: { enabled: true },
              userActionRequest: { enabled: false },
            },
          },
        },
      },
    });

    expect(parsed.attentionDeliveryPolicyV1.events.permission_request.enabled).toBe(false);
    expect(parsed.attentionDeliveryPolicyV1.events.user_action_request.enabled).toBe(false);
    expect(parsed.attentionDeliveryPolicyV1.channels.local_notification.events).toMatchObject({
      permission_request: { enabled: true },
      user_action_request: { enabled: false },
    });
  });
});
