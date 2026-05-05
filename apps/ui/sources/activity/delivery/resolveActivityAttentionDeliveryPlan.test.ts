import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { localSettingsDefaults, localSettingsParse } from '@/sync/domains/settings/localSettings';

import { resolveActivityAttentionDeliveryPlan } from './resolveActivityAttentionDeliveryPlan';
import { ACTIVITY_SURFACE_SELECTION_IDS } from '../selection/activitySurfaceSelectionTypes';

describe('resolveActivityAttentionDeliveryPlan', () => {
    it('uses the account delivery policy by default', () => {
        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings: localSettingsDefaults,
            event: 'ready',
            channel: 'local_notification',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('deliver');
        expect(plan.reason).toBe('deliver');
    });

    it('falls back safely when the account delivery policy is malformed', () => {
        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings: {
                notificationsSettingsV1: {
                    v: 1,
                    pushEnabled: false,
                    ready: false,
                },
                attentionDeliveryPolicyV1: 'malformed-policy',
            },
            localSettings: localSettingsDefaults,
            event: 'ready',
            channel: 'local_notification',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('suppress');
        expect(plan.reason).toBe('event_disabled');
    });

    it('lets device overrides suppress local notification events without mutating account settings', () => {
        const accountSettings = accountSettingsParse({});
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                localNotifications: {
                    events: {
                        ready: false,
                    },
                },
            },
        });

        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings,
            localSettings,
            event: 'ready',
            channel: 'local_notification',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('suppress');
        expect(plan.reason).toBe('event_disabled');
        expect(accountSettings.attentionDeliveryPolicyV1.channels.local_notification.events.ready.enabled).toBe(true);
    });

    it('lets a device disable account quiet hours for local channels', () => {
        const accountSettings = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
                },
            },
        });
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                quietHoursOverride: { mode: 'disabled' },
            },
        });

        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings,
            localSettings,
            event: 'ready',
            channel: 'local_notification',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('deliver');
        expect(plan.reason).toBe('deliver');
    });

    it('uses custom device quiet hours when configured', () => {
        const accountSettings = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: false,
                    timezone: 'UTC',
                    windows: [],
                },
            },
        });
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                quietHoursOverride: {
                    mode: 'custom',
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
                },
            },
        });

        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings,
            localSettings,
            event: 'ready',
            channel: 'local_notification',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('suppress');
        expect(plan.reason).toBe('quiet_hours');
        expect(accountSettings.attentionDeliveryPolicyV1.quietHours).toEqual({
            enabled: false,
            timezone: 'UTC',
            windows: [],
        });
    });

    it('uses account defaults when device overrides are disabled', () => {
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                enabled: false,
                localNotifications: {
                    enabled: false,
                    events: {
                        ready: false,
                    },
                },
                quietHoursOverride: {
                    mode: 'custom',
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
                },
            },
        });

        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings,
            event: 'ready',
            channel: 'local_notification',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('deliver');
        expect(plan.reason).toBe('deliver');
    });

    it('mutes local notification sounds when disabled on this device', () => {
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                sounds: {
                    enabled: false,
                },
            },
        });

        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings,
            event: 'ready',
            channel: 'local_notification',
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('deliver');
        expect(plan.sound).toMatchObject({ kind: 'none', volume: 1 });
    });

    it('applies device sound volume without changing the account-selected notification sound', () => {
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                sounds: {
                    volume: 0.25,
                },
            },
        });

        const cases = [
            {
                accountSettings: accountSettingsParse({}),
                expectedSound: { kind: 'bundled', id: 'soft', volume: 0.25 },
            },
            {
                accountSettings: accountSettingsParse({
                    attentionDeliveryPolicyV1: {
                        v: 1,
                        sounds: {
                            defaultSoundId: 'default',
                        },
                    },
                }),
                expectedSound: { kind: 'system_default', id: 'default', volume: 0.25 },
            },
        ];

        for (const testCase of cases) {
            const plan = resolveActivityAttentionDeliveryPlan({
                accountSettings: testCase.accountSettings,
                localSettings,
                event: 'ready',
                channel: 'local_notification',
                now: new Date('2026-05-03T12:00:00.000Z'),
            });

            expect(plan.sound).toMatchObject(testCase.expectedSound);
        }
    });

    it('preserves shared protocol suppression inputs', () => {
        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings: localSettingsDefaults,
            event: 'ready',
            channel: 'local_notification',
            sameSessionVisible: true,
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('suppress');
        expect(plan.reason).toBe('same_session_visible');
    });

    it('lets this device disable terminal-frontmost smart suppression', () => {
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                terminalSmartSuppression: {
                    enabled: false,
                },
            },
        });

        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings,
            event: 'ready',
            channel: 'local_notification',
            terminalFrontmost: true,
            now: new Date('2026-05-03T12:00:00.000Z'),
        });

        expect(plan.delivery).toBe('deliver');
        expect(plan.reason).toBe('deliver');
    });

    it('returns feature-disabled and platform-unsupported decisions from injected facts', () => {
        expect(resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings: localSettingsDefaults,
            event: 'ready',
            channel: 'live_activity',
            featureEnabled: false,
            now: new Date('2026-05-03T12:00:00.000Z'),
        })).toMatchObject({ delivery: 'suppress', reason: 'feature_disabled' });

        expect(resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings: localSettingsDefaults,
            event: 'ready',
            channel: 'live_activity',
            platformSupported: false,
            now: new Date('2026-05-03T12:00:00.000Z'),
        })).toMatchObject({ delivery: 'suppress', reason: 'unsupported_surface' });
    });

    it('applies device badge filters and per-surface privacy overrides', () => {
        const localSettings = localSettingsParse({
            attentionDeviceOverridesV1: {
                v: 1,
                badge: {
                    enabled: true,
                    includeUnread: false,
                },
                liveActivities: {
                    privacyMode: 'status_only',
                },
            },
        });

        expect(resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings,
            event: 'ready',
            channel: 'badge',
            now: new Date('2026-05-03T12:00:00.000Z'),
        })).toMatchObject({ delivery: 'suppress', reason: 'event_disabled' });

        expect(resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings,
            event: 'ready',
            channel: 'live_activity',
            now: new Date('2026-05-03T12:00:00.000Z'),
        })).toMatchObject({ previewBehavior: 'status_only' });
    });

    it('returns pure surface, privacy, stale, dwell, update-budget, and channel decisions', () => {
        const plan = resolveActivityAttentionDeliveryPlan({
            accountSettings: accountSettingsParse({}),
            localSettings: localSettingsDefaults,
            event: 'ready',
            channel: 'live_activity',
            now: new Date('2026-05-03T12:00:00.000Z'),
            surface: 'live_activity',
            requestedSelection: {
                surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.liveActivities,
                enabled: true,
                mode: 'attention',
                selectionReason: 'dynamic_primary',
                maxSelected: 1,
                includeUrgent: true,
                includeReady: true,
                includeThinking: true,
                includeQuietActive: false,
                activeOnly: false,
            },
            staleAfterMs: 30 * 60 * 1_000,
            dwellMs: 2_500,
            updateBudget: {
                minUpdateIntervalMs: 30_000,
                maxUpdatesPerWindow: 4,
                windowMs: 120_000,
                reason: 'locked',
            },
        });

        expect(plan).toMatchObject({
            delivery: 'deliver',
            channelDecision: {
                channel: 'live_activity',
                delivery: 'deliver',
                reason: 'deliver',
            },
            surfacePolicy: {
                surface: 'live_activity',
                selection: {
                    surfaceId: ACTIVITY_SURFACE_SELECTION_IDS.liveActivities,
                    selectionReason: 'dynamic_primary',
                },
                privacyMode: 'include_preview',
                staleAfterMs: 1_800_000,
                dwellMs: 2_500,
                updateBudget: {
                    minUpdateIntervalMs: 30_000,
                    maxUpdatesPerWindow: 4,
                    windowMs: 120_000,
                    reason: 'locked',
                },
            },
        });
    });
});
