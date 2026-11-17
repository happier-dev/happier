import { describe, expect, it, vi, beforeEach } from 'vitest';

import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createAccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const notificationBoundary = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async () => ({
        granted: false, status: 'denied' as const, canAskAgain: true, expires: 'never' as const,
    })),
}));

vi.mock('expo-constants', () => ({
    default: {},
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: notificationBoundary.getPermissionsAsync,
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('@/config', () => ({
    config: { enableDevPushTokenRegistration: true },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

const settingsState: { current: Record<string, unknown> } = {
    current: {
        lastUsedAgent: 'codex',
        serverSelectionGroups: [
            { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
        ],
        serverSelectionActiveTargetKind: 'group',
        serverSelectionActiveTargetId: 'grp-dev',
    },
};

describe('handleUpdateAccountSocketUpdate settings merge', () => {
    beforeEach(() => {
        notificationBoundary.getPermissionsAsync.mockClear();
        settingsState.current = {
            lastUsedAgent: 'codex',
            serverSelectionGroups: [
                { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
            ],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp-dev',
        };
    });

    it('schedules the canonical device reconciliation when a socket update changes Expo push consent', async () => {
        const {
            handleUpdateAccountSocketUpdate,
            startPushTokenReconciliation,
            stopPushTokenReconciliation,
        } = await import('./syncAccount');
        settingsState.current = {
            attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: false } } },
        };

        startPushTokenReconciliation();
        try {
            await handleUpdateAccountSocketUpdate({
                accountUpdate: {
                    settingsV2: {
                        content: {
                            t: 'plain',
                            v: { attentionDeliveryPolicyV1: { v: 1, channels: { expo_push: { enabled: true } } } },
                        },
                        version: 4,
                    },
                },
                updateCreatedAt: 123,
                currentProfile: { ...profileDefaults },
                encryption: null,
                applyProfile: vi.fn(),
                applySettings: vi.fn(),
                getLocalSettings: () => settingsState.current,
                log: { log: vi.fn() },
            });

            await vi.waitFor(() => expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(1));
        } finally {
            stopPushTokenReconciliation();
        }
    });

    it('schedules the canonical device reconciliation when local remote-alert policy changes while idle', async () => {
        const {
            startPushTokenReconciliation,
            stopPushTokenReconciliation,
        } = await import('./syncAccount');
        const { loadLocalSettings, saveLocalSettings } = await import('@/sync/domains/state/settingsPersistence');
        const before = loadLocalSettings();

        startPushTokenReconciliation();
        try {
            saveLocalSettings({
                ...before,
                deviceRemoteAlertsEnabled: !before.deviceRemoteAlertsEnabled,
            });
            await vi.waitFor(() => expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(1));
        } finally {
            stopPushTokenReconciliation();
            saveLocalSettings(before);
        }
    });

    it('coalesces local policy mutations during a failed in-flight pass into one fresh reconciliation', async () => {
        const firstPermissionRead = createDeferred<Awaited<ReturnType<typeof notificationBoundary.getPermissionsAsync>>>();
        notificationBoundary.getPermissionsAsync
            .mockImplementationOnce(() => firstPermissionRead.promise)
            .mockResolvedValue({
                granted: false, status: 'denied', canAskAgain: true, expires: 'never',
            });
        const {
            startPushTokenReconciliation,
            stopPushTokenReconciliation,
        } = await import('./syncAccount');
        const { loadLocalSettings, saveLocalSettings } = await import('@/sync/domains/state/settingsPersistence');
        const before = loadLocalSettings();

        startPushTokenReconciliation();
        try {
            saveLocalSettings({
                ...before,
                deviceRemoteAlertsEnabled: !before.deviceRemoteAlertsEnabled,
            });
            await vi.waitFor(() => expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(1));

            saveLocalSettings({
                ...before,
                attentionDeviceOverridesV1: {
                    ...before.attentionDeviceOverridesV1,
                    privacy: { previewBehavior: 'status_only' },
                },
            });
            saveLocalSettings({
                ...before,
                attentionDeviceOverridesV1: {
                    ...before.attentionDeviceOverridesV1,
                    privacy: { previewBehavior: 'title_only' },
                },
            });
            firstPermissionRead.reject(new Error('transient permission boundary failure'));

            await vi.waitFor(() => expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(2));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(2);
        } finally {
            stopPushTokenReconciliation();
            saveLocalSettings(before);
        }
    });

    it('schedules the canonical device reconciliation when persisted Account preview policy changes without changing push enablement', async () => {
        const {
            startPushTokenReconciliation,
            stopPushTokenReconciliation,
        } = await import('./syncAccount');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const scope = createAccountSettingsScope('server-a', 'account-a');
        expect(scope).not.toBeNull();
        if (!scope) return;

        startPushTokenReconciliation();
        try {
            saveAccountSettings(scope, {
                ...settingsDefaults,
                attentionDeliveryPolicyV1: {
                    ...settingsDefaults.attentionDeliveryPolicyV1,
                    channels: {
                        ...settingsDefaults.attentionDeliveryPolicyV1.channels,
                        expo_push: {
                            ...settingsDefaults.attentionDeliveryPolicyV1.channels.expo_push,
                            enabled: true,
                            previewBehavior: 'status_only',
                        },
                    },
                },
            }, 4);

            await vi.waitFor(() => expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(1));
        } finally {
            stopPushTokenReconciliation();
        }
    });

    it('coalesces persisted Account quiet-hours mutations during an in-flight pass into one fresh reconciliation', async () => {
        const firstPermissionRead = createDeferred<Awaited<ReturnType<typeof notificationBoundary.getPermissionsAsync>>>();
        notificationBoundary.getPermissionsAsync
            .mockImplementationOnce(() => firstPermissionRead.promise)
            .mockResolvedValue({
                granted: false, status: 'denied', canAskAgain: true, expires: 'never',
            });
        const {
            startPushTokenReconciliation,
            stopPushTokenReconciliation,
        } = await import('./syncAccount');
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const scope = createAccountSettingsScope('server-a', 'account-a');
        expect(scope).not.toBeNull();
        if (!scope) return;

        startPushTokenReconciliation();
        try {
            saveAccountSettings(scope, settingsDefaults, 4);
            await vi.waitFor(() => expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(1));

            saveAccountSettings(scope, {
                ...settingsDefaults,
                attentionDeliveryPolicyV1: {
                    ...settingsDefaults.attentionDeliveryPolicyV1,
                    quietHours: {
                        enabled: true,
                        timezone: 'Europe/Zurich',
                        windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }],
                    },
                },
            }, 4);
            firstPermissionRead.resolve({
                granted: false, status: 'denied', canAskAgain: true, expires: 'never',
            });

            await vi.waitFor(() => expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(2));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(notificationBoundary.getPermissionsAsync).toHaveBeenCalledTimes(2);
        } finally {
            stopPushTokenReconciliation();
        }
    });

    it('preserves local server-selection keys when applying account socket settings updates', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        const machineKey = new Uint8Array(32).fill(7);
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            payload: { analyticsOptOut: true },
            randomBytes: () => new Uint8Array(24).fill(1),
        });
        const encryption = {
            getContentPrivateKey: () => machineKey,
            decryptRaw: vi.fn().mockResolvedValue({
                analyticsOptOut: true,
            }),
        } as any;

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settings: {
                    value: ciphertext,
                    version: 7,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption,
            applyProfile,
            applySettings,
            getLocalSettings: () => settingsState.current,
            log: { log: vi.fn() },
        });

        expect(encryption.decryptRaw).not.toHaveBeenCalled();
        expect(applySettings).toHaveBeenCalledWith(
            expect.objectContaining({
                analyticsOptOut: true,
                lastUsedAgent: 'codex',
                serverSelectionGroups: [
                    { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            }),
            7,
        );
    });

    it('applies account socket settings updates through the captured settings scope when provided', async () => {
        const { handleUpdateAccountSocketUpdate } = await import('./syncAccount');

        const settingsScope = createAccountSettingsScope('server-a', 'account-a');
        expect(settingsScope).not.toBeNull();
        const applyProfile = vi.fn();
        const applySettings = vi.fn();
        const applySettingsForScope = vi.fn();
        const machineKey = new Uint8Array(32).fill(7);
        const encryption = {
            getContentPrivateKey: () => machineKey,
            decryptRaw: vi.fn(),
        } as any;

        await handleUpdateAccountSocketUpdate({
            accountUpdate: {
                settingsV2: {
                    content: { t: 'plain', v: { analyticsOptOut: true } },
                    version: 3,
                },
            },
            updateCreatedAt: 123,
            currentProfile: { ...profileDefaults },
            encryption,
            settingsScope,
            applyProfile,
            applySettings,
            applySettingsForScope,
            getLocalSettings: () => settingsState.current,
            log: { log: vi.fn() },
        });

        expect(applySettings).not.toHaveBeenCalled();
        expect(applySettingsForScope).toHaveBeenCalledWith(
            settingsScope,
            expect.objectContaining({
                analyticsOptOut: true,
                lastUsedAgent: 'codex',
                serverSelectionGroups: [
                    { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
                ],
            }),
            3,
        );
    });
});
