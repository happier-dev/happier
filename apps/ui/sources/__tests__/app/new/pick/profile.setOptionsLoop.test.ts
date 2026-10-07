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
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

enableReactActEnvironment();

const setOptionsSpy = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<() => void>());
const navigationApi = createNavigationMock();
const routerApi = createRouterMock();
let searchParams = { selectedId: '', machineId: 'm1' };

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

const runtime = installSessionPaneRuntimeTestHarness();

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
        const screen = await renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(ProfilePickerScreen)));

        searchParams = { selectedId: 'profile-1', machineId: 'm1' };
        await screen.update(React.createElement(runtime.Wrapper, null, React.createElement(ProfilePickerScreen)));

        const setOptionsCalls = setOptionsSpy.mock.calls.length;
        const observedOptions = setOptionsSpy.mock.calls.map(([options]) => options);

        expect(setOptionsCalls).toBeGreaterThan(0);
        expect(setOptionsCalls).toBeLessThanOrEqual(2);
        expect(observedOptions.every((entry) => entry === observedOptions[0])).toBe(true);
    });
});
