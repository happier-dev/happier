import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const setOptionsSpy = vi.hoisted(() => vi.fn());
const navigationApi = createNavigationMock();
const routerApi = createRouterMock();
let localSearchParams = { selectedId: '' };

installPickerCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
            Pressable: 'Pressable',
        }),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: { colors: { chrome: PICKER_THEME_COLORS.chrome } },
        }),
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const baseModule = createExpoRouterMock({
            navigation: navigationApi,
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
                        setOptionsSpy(options);
                    }, [options]);
                    return null;
                },
            },
            useNavigation: () => navigationApi,
            useLocalSearchParams: () => localSearchParams,
        };
    },
});

const runtime = installSessionPaneRuntimeTestHarness();

describe('SecretPickerScreen (Stack.Screen options stability)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        localSearchParams = { selectedId: '' };
        setOptionsSpy.mockClear();
        navigationApi.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });
        navigationApi.dispatch.mockClear();
        navigationApi.goBack.mockClear();
        navigationApi.setParams.mockClear();
        routerApi.push.mockClear();
        routerApi.back.mockClear();
        routerApi.replace.mockClear();
        routerApi.setParams.mockClear();
    });

    it('keeps Stack.Screen options referentially stable across parent re-renders', async () => {
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;
        let tree: renderer.ReactTestRenderer | undefined;

        tree = (await renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(SecretPickerScreen)))).tree;

        localSearchParams = { selectedId: 'secret-1' };
        await act(async () => {
            tree?.update(React.createElement(runtime.Wrapper, null, React.createElement(SecretPickerScreen)));
        });

        expect(setOptionsSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.unmount();
        });
    });
});
