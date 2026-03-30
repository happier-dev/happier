import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_THEME_COLORS,
    createRouterMock,
} from './testHarness';
import type { PickerStackScreenOptions } from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

installPickerCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
    expoRouter: async () =>
        (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: { selectedId: '', machineId: 'm1' },
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module,
    unistyles: async () =>
        (await import('@/dev/testkit')).createUnistylesMock({
            theme: { colors: PICKER_THEME_COLORS },
        }),
    modal: async () =>
        (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
            spies: {
                alert: vi.fn(),
                show: vi.fn(),
            },
        }).module,
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: () => false,
                useSettingMutable: () => [[], vi.fn()],
            },
        }),
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => null,
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementModal: () => null,
}));

vi.mock('@/utils/secrets/secretSatisfaction', () => ({
    getSecretSatisfaction: () => ({ isSatisfied: true, items: [] }),
}));

vi.mock('@/sync/domains/profiles/profileSecrets', () => ({
    getRequiredSecretEnvVarNames: () => [],
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({ refresh: vi.fn(), machineEnvReadyByName: {} }),
}));

vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: vi.fn(async () => ({ supported: false })),
}));

vi.mock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profileCompatibility')>();
    return {
        ...actual,
        getProfileEnvironmentVariables: () => ({}),
    };
});

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: () => 'temp',
    getTempData: () => null,
}));

describe('ProfilePickerScreen (iOS presentation)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        stackOptionsCapture.reset();
        navigationMock.goBack.mockClear();
    });

    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        await renderScreen(React.createElement(ProfilePickerScreen));

        const resolvedOptions = stackOptionsCapture.getResolved() as PickerStackScreenOptions | null;
        expect(resolvedOptions?.presentation).toBe('containedModal');
        expect(typeof resolvedOptions?.headerLeft).toBe('function');

        const backButton = typeof resolvedOptions?.headerLeft === 'function'
            ? resolvedOptions.headerLeft()
            : null;
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(navigationMock.goBack).toHaveBeenCalledTimes(1);
    });
});
