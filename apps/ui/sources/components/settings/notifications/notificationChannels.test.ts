import { describe, expect, it } from 'vitest';

import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    accountSettingsParse,
} from '@happier-dev/protocol';

import {
    addWebhookNotificationChannel,
    buildWebhookNotificationSettingsDelta,
    removeNotificationChannelById,
    updateNotificationChannelById,
} from './notificationChannels';

const enabledLegacyNotificationTopics = {
    ready: true,
    permissionRequest: true,
    userActionRequest: true,
    connectedServiceAccountSwitch: true,
    connectedServiceQuotaBlocked: true,
    connectedServiceQuotaRecovered: true,
};

describe('notificationChannels helpers', () => {
    it('adds a webhook channel alongside the builtin expo channel', () => {
        const next = addWebhookNotificationChannel({
            channels: [],
            url: 'https://hooks.example.test/notify',
        });

        expect(next).toEqual([
            {
                v: 1,
                id: 'webhook-hooks-example-test-notify',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: enabledLegacyNotificationTopics,
                readyIncludeMessageText: false,
            },
        ]);
    });

    it('updates a webhook channel without changing other channels', () => {
        const next = updateNotificationChannelById({
            channels: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: enabledLegacyNotificationTopics,
                    readyIncludeMessageText: true,
                },
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: enabledLegacyNotificationTopics,
                    readyIncludeMessageText: false,
                },
            ],
            channelId: 'webhook-primary',
            patch: {
                enabled: false,
                topics: {
                    ready: false,
                    permissionRequest: true,
                    userActionRequest: false,
                    connectedServiceAccountSwitch: true,
                    connectedServiceQuotaBlocked: true,
                    connectedServiceQuotaRecovered: true,
                },
            },
        });

        expect(next).toEqual([
            {
                v: 1,
                id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                kind: 'expo_push',
                enabled: true,
                topics: enabledLegacyNotificationTopics,
                readyIncludeMessageText: true,
            },
            {
                v: 1,
                id: 'webhook-primary',
                kind: 'webhook',
                enabled: false,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: {
                    ready: false,
                    permissionRequest: true,
                    userActionRequest: false,
                    connectedServiceAccountSwitch: true,
                    connectedServiceQuotaBlocked: true,
                    connectedServiceQuotaRecovered: true,
                },
                readyIncludeMessageText: false,
            },
        ]);
    });

    it('removes a webhook channel by id', () => {
        const next = removeNotificationChannelById({
            channels: [
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: enabledLegacyNotificationTopics,
                    readyIncludeMessageText: false,
                },
            ],
            channelId: 'webhook-primary',
        });

        expect(next).toEqual([]);
    });

    it('builds a synced settings delta without writing legacy notification toggles', () => {
        const basePolicy = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                channels: {
                    expo_push: {
                        previewBehavior: 'status_only',
                    },
                },
            },
        }).attentionDeliveryPolicyV1;

        const delta = buildWebhookNotificationSettingsDelta({
            basePolicy,
            webhookChannels: [
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                topics: {
                    ready: true,
                    permissionRequest: false,
                    userActionRequest: true,
                    connectedServiceAccountSwitch: true,
                    connectedServiceQuotaBlocked: true,
                    connectedServiceQuotaRecovered: true,
                },
                    readyIncludeMessageText: false,
                },
            ],
        });

        expect(delta).toMatchObject({
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: enabledLegacyNotificationTopics,
                    readyIncludeMessageText: false,
                },
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                topics: {
                    ready: true,
                    permissionRequest: false,
                    userActionRequest: true,
                    connectedServiceAccountSwitch: true,
                    connectedServiceQuotaBlocked: true,
                    connectedServiceQuotaRecovered: true,
                },
                    readyIncludeMessageText: false,
                },
            ],
            attentionDeliveryPolicyV1: {
                channels: {
                    expo_push: {
                        previewBehavior: 'status_only',
                        events: {
                            ready: { enabled: true },
                            permission_request: { enabled: true },
                            user_action_request: { enabled: true },
                        },
                    },
                    webhook: {
                        events: {
                            ready: { enabled: true },
                            permission_request: { enabled: false },
                            user_action_request: { enabled: true },
                        },
                    },
                },
            },
        });
        expect(delta).not.toHaveProperty('notificationsSettingsV1');
    });

    it('preserves unrelated canonical attention policy while mirroring legacy channel edits', () => {
        const basePolicy = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }],
                },
                sounds: {
                    defaultSoundId: 'none',
                },
                foregroundBehavior: 'silent',
                channels: {
                    webhook: {
                        quietHoursBehavior: 'suppress',
                    },
                },
            },
        }).attentionDeliveryPolicyV1;

        const delta = buildWebhookNotificationSettingsDelta({
            basePolicy,
            webhookChannels: [
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: enabledLegacyNotificationTopics,
                    readyIncludeMessageText: false,
                },
            ],
        });

        expect(delta.attentionDeliveryPolicyV1.quietHours).toEqual(basePolicy.quietHours);
        expect(delta.attentionDeliveryPolicyV1.sounds).toEqual(basePolicy.sounds);
        expect(delta.attentionDeliveryPolicyV1.foregroundBehavior).toBe('silent');
        expect(delta.attentionDeliveryPolicyV1.channels.webhook.quietHoursBehavior).toBe('suppress');
        expect(delta.attentionDeliveryPolicyV1.channels.webhook.events.permission_request.enabled).toBe(true);
    });
});
