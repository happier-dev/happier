import { describe, expect, it } from 'vitest';

import { resolveForegroundNotificationBehavior } from './resolveForegroundNotificationBehavior';

describe('resolveForegroundNotificationBehavior', () => {
    it('prefers device-local notification disablement over synced account settings', () => {
        expect(resolveForegroundNotificationBehavior({
            localSettings: {
                localNotificationsEnabled: false,
                localNotificationsForegroundBehavior: 'full',
            },
            accountSettings: {
                notificationsSettingsV1: {
                    v: 1,
                    pushEnabled: true,
                    ready: true,
                    readyIncludeMessageText: true,
                    permissionRequest: true,
                    userActionRequest: true,
                    foregroundBehavior: 'full',
                },
            },
        })).toBe('off');
    });

    it('uses the local device foreground behavior when notifications are enabled', () => {
        expect(resolveForegroundNotificationBehavior({
            localSettings: {
                localNotificationsEnabled: true,
                localNotificationsForegroundBehavior: 'silent',
            },
            accountSettings: {
                notificationsSettingsV1: {
                    v: 1,
                    pushEnabled: true,
                    ready: true,
                    readyIncludeMessageText: true,
                    permissionRequest: true,
                    userActionRequest: true,
                    foregroundBehavior: 'full',
                },
            },
        })).toBe('silent');
    });

    it('falls back to the synced account setting when local preferences are absent', () => {
        expect(resolveForegroundNotificationBehavior({
            localSettings: null,
            accountSettings: {
                notificationsSettingsV1: {
                    v: 1,
                    pushEnabled: true,
                    ready: true,
                    readyIncludeMessageText: true,
                    permissionRequest: true,
                    userActionRequest: true,
                    foregroundBehavior: 'silent',
                },
            },
        })).toBe('silent');
    });
});
