import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { flushHookEffects } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runPrimingMock = vi.fn(async () => ({ decision: 'prime' as const, granted: false }));
const state = {
    isDataReady: true,
    settings: { notificationsSettingsV1: { v: 1, pushEnabled: true } } as unknown,
};

vi.mock('./pushNotificationPermissionPriming', () => ({
    runPushNotificationPermissionPriming: (...args: unknown[]) => runPrimingMock(...(args as [])),
}));

vi.mock('@/sync/sync', () => ({
    sync: { onPushPermissionGranted: vi.fn() },
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useIsDataReady: () => state.isDataReady,
            useSettings: () => state.settings,
        });
    },
});

describe('PushNotificationPermissionPrimingRuntime', () => {
    beforeEach(() => {
        runPrimingMock.mockClear();
        state.isDataReady = true;
        state.settings = { notificationsSettingsV1: { v: 1, pushEnabled: true } };
    });

    it('asks once after account data is ready', async () => {
        const { PushNotificationPermissionPrimingRuntime } = await import('./PushNotificationPermissionPrimingRuntime');
        await renderSettingsView(<PushNotificationPermissionPrimingRuntime />);
        await flushHookEffects({ cycles: 10 });

        expect(runPrimingMock).toHaveBeenCalledTimes(1);
        expect(runPrimingMock).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'automatic', pushEnabled: true }));
    });

    it('waits for hydrated account data before asking', async () => {
        state.isDataReady = false;
        const { PushNotificationPermissionPrimingRuntime } = await import('./PushNotificationPermissionPrimingRuntime');
        await renderSettingsView(<PushNotificationPermissionPrimingRuntime />);
        await flushHookEffects({ cycles: 10 });

        expect(runPrimingMock).not.toHaveBeenCalled();
    });

    it('does not ask when the account disabled push notifications', async () => {
        state.settings = { notificationsSettingsV1: { v: 1, pushEnabled: false } };
        const { PushNotificationPermissionPrimingRuntime } = await import('./PushNotificationPermissionPrimingRuntime');
        await renderSettingsView(<PushNotificationPermissionPrimingRuntime />);
        await flushHookEffects({ cycles: 10 });

        expect(runPrimingMock).not.toHaveBeenCalled();
    });
});
