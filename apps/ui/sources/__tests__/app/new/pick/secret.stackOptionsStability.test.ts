import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
    type PickerStackScreenOptions,
} from './testHarness';

enableReactActEnvironment();

const setOptionsSpy = vi.hoisted(() => vi.fn<(options: PickerStackScreenOptions) => void>());
const navigationApi = createNavigationMock();
const routerApi = createRouterMock();
let localSearchParams: Record<string, string> = { selectedId: '' };

await installPickerCommonModuleMocks({
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
            params: () => localSearchParams,
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
                Screen: ({ options }: { options: PickerStackScreenOptions }) => {
                    React.useEffect(() => {
                        setOptionsSpy(options);
                    }, [options]);
                    return null;
                },
            },
            useNavigation: () => navigationApi,
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
        localSearchParams = { selectedId: '', dataId: 'first-draft' };
        navigationApi.getState = () => ({ index: 0, routes: [{
            key: 'secret-picker', name: '(app)/new/pick/secret', path: '/new/pick/secret',
        }] });
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;
        const screen = await renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(SecretPickerScreen)));
        const firstOptions = setOptionsSpy.mock.calls.at(-1)?.[0];
        if (!firstOptions) throw new Error('Expected Secret picker screen options');

        const { router } = await import('expo-router');
        await act(async () => {
            router.setParams({ selectedId: 'secret-1', dataId: 'next-draft' });
        });
        await screen.update(React.createElement(runtime.Wrapper, null, React.createElement(SecretPickerScreen)));

        expect(setOptionsSpy).toHaveBeenCalledTimes(1);
        expect(setOptionsSpy.mock.calls.at(-1)?.[0]).toBe(firstOptions);
        const backButton = firstOptions.headerLeft?.();
        if (!backButton?.props.onPress) throw new Error('Expected Secret picker header back action');
        await act(async () => { backButton.props.onPress?.(); });
        expect(routerApi.replace).toHaveBeenCalledWith({ pathname: '/new', params: { dataId: 'next-draft' } });

        await screen.unmount();
    });
});
