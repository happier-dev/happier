import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { Modal } from '@/modal';
import { clearDeclinedPushPermissionPriming } from './pushPermissionPrimingRecord';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(async () => ({ status: 'undetermined', granted: false, canAskAgain: true })),
}));

vi.mock('@/sync/sync', () => ({
    sync: { onPushPermissionGranted: vi.fn() },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

describe('PushNotificationPermissionPrimingRuntime', () => {
    beforeEach(async () => {
        getPersistenceStorage().clearAll();
        clearDeclinedPushPermissionPriming();
        vi.mocked(Modal.confirm).mockClear();
        await storage.getState().activateSettingsScope({ serverId: 'push-home', accountId: 'push-account' });
        storage.getState().applySettings(settingsDefaults, 1);
        storage.setState({ isDataReady: true });
    });

    it('asks once after account data is ready', async () => {
        const { PushNotificationPermissionPrimingRuntime } = await import('./PushNotificationPermissionPrimingRuntime');
        await renderScreen(<PushNotificationPermissionPrimingRuntime />);
        await flushHookEffects({ cycles: 10 });

        expect(Modal.confirm).toHaveBeenCalledTimes(1);
    });

    it('waits for hydrated account data before asking', async () => {
        storage.setState({ isDataReady: false });
        const { PushNotificationPermissionPrimingRuntime } = await import('./PushNotificationPermissionPrimingRuntime');
        await renderScreen(<PushNotificationPermissionPrimingRuntime />);
        await flushHookEffects({ cycles: 10 });

        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it('does not ask when the account disabled push notifications', async () => {
        storage.getState().applySettings(settingsParse({ notificationsSettingsV1: { v: 1, pushEnabled: false } }), 2);
        const { PushNotificationPermissionPrimingRuntime } = await import('./PushNotificationPermissionPrimingRuntime');
        await renderScreen(<PushNotificationPermissionPrimingRuntime />);
        await flushHookEffects({ cycles: 10 });

        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it('ignores unrelated settings and asks when the account enables push', async () => {
        const policy = settingsDefaults.attentionDeliveryPolicyV1;
        storage.getState().applySettingsLocal({
            attentionDeliveryPolicyV1: { ...policy, channels: { ...policy.channels, expo_push: { ...policy.channels.expo_push, enabled: false } } },
        });
        const { PushNotificationPermissionPrimingRuntime } = await import('./PushNotificationPermissionPrimingRuntime');
        const commits = vi.fn();
        await renderScreen(
            <React.Profiler id="push-priming" onRender={commits}>
                <PushNotificationPermissionPrimingRuntime />
            </React.Profiler>,
        );
        const baseline = commits.mock.calls.length;
        await act(async () => {
            storage.getState().applySettingsLocal({ favoriteDirectories: ['~/code'] });
        });
        expect(commits.mock.calls.length).toBe(baseline);
        await act(async () => {
            storage.getState().applySettingsLocal({ attentionDeliveryPolicyV1: policy });
        });
        await flushHookEffects({ cycles: 10 });
        expect(commits.mock.calls.length).toBe(baseline + 1);
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
    });
});
