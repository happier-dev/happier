import { describe, expect, it } from 'vitest';

import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
} from '@happier-dev/protocol';

import {
    addWebhookNotificationChannel,
    buildNotificationSettingsDelta,
    removeNotificationChannelById,
    updateNotificationChannelById,
} from './notificationChannels';

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
                topics: {
                    ready: true,
                    permissionRequest: true,
                    userActionRequest: true,
                },
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
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: true,
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
                        permissionRequest: true,
                        userActionRequest: true,
                    },
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
                },
            },
        });

        expect(next).toEqual([
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
                    topics: {
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
                    readyIncludeMessageText: false,
                },
            ],
            channelId: 'webhook-primary',
        });

        expect(next).toEqual([]);
    });

    it('builds a synced settings delta that keeps legacy expo settings mirrored', () => {
        const delta = buildNotificationSettingsDelta({
            notifications: {
                ...DEFAULT_NOTIFICATIONS_SETTINGS_V1,
                readyIncludeMessageText: false,
            },
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
                    },
                    readyIncludeMessageText: false,
                },
            ],
        });

        expect(delta).toEqual({
            notificationsSettingsV1: {
                v: 1,
                pushEnabled: true,
                ready: true,
                readyIncludeMessageText: false,
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
                        ready: true,
                        permissionRequest: true,
                        userActionRequest: true,
                    },
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
                    },
                    readyIncludeMessageText: false,
                },
            ],
        });
    });
});
