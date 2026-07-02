import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { localSettingsParse } from '@/sync/domains/settings/localSettings';
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
                    connectedServiceAccountSwitch: true,
                    connectedServiceQuotaBlocked: true,
                    connectedServiceQuotaRecovered: true,
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
                    connectedServiceAccountSwitch: true,
                    connectedServiceQuotaBlocked: true,
                    connectedServiceQuotaRecovered: true,
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
                    connectedServiceAccountSwitch: true,
                    connectedServiceQuotaBlocked: true,
                    connectedServiceQuotaRecovered: true,
                    foregroundBehavior: 'silent',
                },
            },
        })).toBe('silent');
    });

    it('falls back to the default behavior when account settings are malformed', () => {
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
                    foregroundBehavior: 'not-a-real-mode',
                } as never,
            },
        })).toBe('full');
    });

    it('uses the unified account delivery foreground behavior when present', () => {
        expect(resolveForegroundNotificationBehavior({
            localSettings: {},
            accountSettings: accountSettingsParse({
                attentionDeliveryPolicyV1: {
                    v: 1,
                    foregroundBehavior: 'silent',
                },
            }),
        })).toBe('silent');
    });

    it('lets nested device foreground overrides supersede account delivery policy', () => {
        expect(resolveForegroundNotificationBehavior({
            localSettings: localSettingsParse({
                attentionDeviceOverridesV1: {
                    v: 1,
                    foregroundBehavior: 'off',
                },
            }),
            accountSettings: accountSettingsParse({
                attentionDeliveryPolicyV1: {
                    v: 1,
                    foregroundBehavior: 'full',
                },
            }),
        })).toBe('off');
    });
});
