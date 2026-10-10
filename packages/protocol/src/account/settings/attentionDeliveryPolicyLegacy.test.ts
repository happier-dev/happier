import { describe, expect, it } from 'vitest';

import {
  accountSettingsParse,
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  NotificationsSettingsV1Schema,
} from './accountSettings.js';
import { AttentionDeliveryPolicyV1Schema } from './attentionDeliveryPolicy.js';
import { deriveAttentionDeliveryPolicyFromLegacySettings } from './attentionDeliveryPolicyLegacy.js';
import { NotificationChannelsV1Schema } from './notificationChannels.js';

// Explicit retained-source callers still own the predecessor's combined policy.
// Current finite preferences must not acquire endpoint membership from that seam.
function retainedSourcePolicy(raw: Readonly<Record<string, unknown>>) {
  return { attentionDeliveryPolicyV1: deriveAttentionDeliveryPolicyFromLegacySettings({
    notificationsSettings: NotificationsSettingsV1Schema.parse(raw.notificationsSettingsV1),
    notificationChannels: NotificationChannelsV1Schema.parse(raw.notificationChannelsV1),
  }) };
}

describe('attentionDeliveryPolicyV1 legacy backfill', () => {
  it('derives finite attention intent without endpoint membership', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        pushEnabled: false,
        ready: false,
        permissionRequest: true,
        userActionRequest: false,
        requestIncludeMessageText: false,
        foregroundBehavior: 'silent',
      },
    });

    expect(parsed.attentionDeliveryPolicyV1.channels.webhook)
      .toEqual(AttentionDeliveryPolicyV1Schema.parse({}).channels.webhook);
    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push).toMatchObject({
      enabled: false,
      events: {
        ready: { enabled: false },
        permission_request: { enabled: true, previewBehavior: 'status_only' },
        user_action_request: { enabled: false, previewBehavior: 'status_only' },
      },
    });
    expect(parsed.attentionDeliveryPolicyV1.events.ready.enabled).toBe(false);
    expect(parsed.attentionDeliveryPolicyV1.foregroundBehavior).toBe('silent');
  });

  it('keeps retained disabled endpoint guards out of finite attention intent', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        pushEnabled: true,
        ready: true,
        permissionRequest: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
      },
      notificationChannelsV1: [{
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: false,
        topics: { ready: false, permissionRequest: false, userActionRequest: false },
        readyIncludeMessageText: false,
        requestIncludeMessageText: false,
      }],
    });

    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push).toMatchObject({
      enabled: true,
      previewBehavior: 'include_preview',
      events: {
        ready: { enabled: true },
        permission_request: { enabled: true, previewBehavior: 'include_preview' },
      },
    });
    expect(parsed.attentionDeliveryPolicyV1.channels.webhook)
      .toEqual(AttentionDeliveryPolicyV1Schema.parse({}).channels.webhook);
  });

  it.each([false, true])('maps request preview opt-in %s independently from ready previews', (requestIncludeMessageText) => {
    const parsed = accountSettingsParse({ notificationsSettingsV1: { readyIncludeMessageText: true, requestIncludeMessageText } });
    const channel = parsed.attentionDeliveryPolicyV1.channels.expo_push;
    expect(channel.events.permission_request.previewBehavior).toBe(requestIncludeMessageText ? 'include_preview' : 'status_only');
    expect(channel.events.user_action_request.previewBehavior).toBe(requestIncludeMessageText ? 'include_preview' : 'status_only');
    expect(channel.previewBehavior).toBe('include_preview');
    expect(channel.events.permission_request.enabled).toBe(true);
  });

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

  it('preserves explicit retained-source channel event toggles at the compatibility helper', () => {
    const parsed = retainedSourcePolicy({
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
    const parsed = retainedSourcePolicy({
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
    const withoutWebhooks = retainedSourcePolicy({
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

    const withMixedWebhooks = retainedSourcePolicy({
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
    const parsed = retainedSourcePolicy({
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
