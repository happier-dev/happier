import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    expoRouter: async () =>
        (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: { selectedId: 'm1' },
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module,
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useAllMachines: () => [],
                useSessions: () => [],
                useSetting: () => false,
                useSettingMutable: () => [[], vi.fn()],
            },
        }),
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
    getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshMachinesThrottled: vi.fn() },
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    prefetchMachineCapabilities: vi.fn(),
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    invalidateMachineEnvPresence: vi.fn(),
}));

describe('MachinePickerScreen (back fallback)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        stackOptionsCapture.reset();
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        (navigationMock as any).canGoBack = undefined;
    });

    it('replaces to /new when it cannot go back', async () => {
        (navigationMock as any).canGoBack = () => false;
        const MachinePickerScreen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(MachinePickerScreen));

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerLeft).toBe('function');

        const backButton = options?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();

        expect(routerMock.replace).toHaveBeenCalledWith('/new');
        expect(routerMock.back).toHaveBeenCalledTimes(0);
    });
});
