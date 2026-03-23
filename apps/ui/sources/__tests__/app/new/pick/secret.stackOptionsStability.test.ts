import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { Settings } from '@/sync/domains/settings/settings';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const setOptionsSpy = vi.hoisted(() => vi.fn());
const navigationApi = createNavigationMock();
const routerApi = createRouterMock();
let localSearchParams = { selectedId: '' };

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        Platform: { OS: 'ios' },
                                        Pressable: 'Pressable',
                                    }
    );
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: <K extends keyof Settings>(name: K): [Settings[K], (value: Settings[K]) => void] => {
                if (name !== 'secrets') {
                    throw new Error(`Unexpected setting key in secret picker test: ${String(name)}`);
                }
                return React.useState<Settings['secrets']>([]) as [Settings[K], (value: Settings[K]) => void];
            },
        },
    }));

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: () => null,
}));

vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
        theme: { colors: { header: PICKER_THEME_COLORS.header } },
    }));

vi.mock('expo-router', async () => {
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
});

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

        tree = (await renderScreen(React.createElement(SecretPickerScreen))).tree;

        localSearchParams = { selectedId: 'secret-1' };
        await act(async () => {
            tree?.update(React.createElement(SecretPickerScreen));
        });

        expect(setOptionsSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.unmount();
        });
    });
});
