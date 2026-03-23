import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_NAV_STATE,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const setOptionsSpy = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<() => void>());
const navigationApi = createNavigationMock();
const routerApi = createRouterMock();
let searchParams = { selectedId: '', machineId: 'm1' };

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
installPickerCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
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
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const baseModule = createExpoRouterMock({
            navigation: navigationApi,
            params: searchParams,
            router: {
                push: routerApi.push,
                back: routerApi.back,
                replace: routerApi.replace,
                setParams: routerApi.setParams,
            },
        }).module;

        return {
            ...baseModule,
            Stack: {
                Screen: ({ options }: { options: PickerStackOptionsInput }) => {
                    React.useEffect(() => {
                        setOptionsSpy(typeof options === 'function' ? options() : options);
                        listeners.forEach((notify) => notify());
                    }, [options]);
                    return null;
                },
            },
            useNavigation: () => {
                const [, force] = React.useReducer((value) => value + 1, 0);
                React.useLayoutEffect(() => {
                    listeners.add(force);
                    return () => {
                        listeners.delete(force);
                    };
                }, [force]);
                return navigationApi;
            },
            useLocalSearchParams: () => searchParams,
        };
    },
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
    useMachineEnvPresence: () => ({ isLoading: false, isPreviewEnvSupported: false, meta: {} }),
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

describe('ProfilePickerScreen (Stack.Screen options stability)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        listeners.clear();
        searchParams = { selectedId: '', machineId: 'm1' };
        setOptionsSpy.mockClear();
        navigationApi.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });
    });

    it('does not trigger an infinite setOptions update loop', async () => {
        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        const screen = await renderScreen(React.createElement(ProfilePickerScreen));

        searchParams = { selectedId: 'profile-1', machineId: 'm1' };
        await screen.update(React.createElement(ProfilePickerScreen));

        const setOptionsCalls = setOptionsSpy.mock.calls.length;
        const observedOptions = setOptionsSpy.mock.calls.map(([options]) => options);

        expect(setOptionsCalls).toBeGreaterThan(0);
        expect(setOptionsCalls).toBeLessThanOrEqual(2);
        expect(observedOptions.every((entry) => entry === observedOptions[0])).toBe(true);
    });
});
