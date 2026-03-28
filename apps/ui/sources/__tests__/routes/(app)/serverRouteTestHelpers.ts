import * as React from 'react';
import { vi } from 'vitest';

type ServerRouteModuleFactory = () => unknown | Promise<unknown>;

type InstallServerRouteCommonModuleMocksOptions = Readonly<{
    reactNative?: ServerRouteModuleFactory;
    router?: ServerRouteModuleFactory;
    unistyles?: ServerRouteModuleFactory;
    text?: ServerRouteModuleFactory;
    modal?: ServerRouteModuleFactory;
}>;

const serverRouteModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ServerRouteModuleFactory | undefined,
        router: undefined as ServerRouteModuleFactory | undefined,
        unistyles: undefined as ServerRouteModuleFactory | undefined,
        text: undefined as ServerRouteModuleFactory | undefined,
        modal: undefined as ServerRouteModuleFactory | undefined,
    },
}));

export function installServerRouteCommonModuleMocks(
    options: InstallServerRouteCommonModuleMocksOptions = {},
) {
    serverRouteModuleState.options = {
        reactNative: options.reactNative,
        router: options.router,
        unistyles: options.unistyles,
        text: options.text,
        modal: options.modal,
    };

    vi.mock('react-native-reanimated', () => ({}));

    vi.mock('react-native-typography', () => ({
        human: {},
        iOSUIKit: {},
        material: {},
    }));

    vi.mock('react-native', async () => {
        const activeOptions = serverRouteModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            KeyboardAvoidingView: 'KeyboardAvoidingView',
            Platform: { OS: 'ios' },
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = serverRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = serverRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('expo-updates', () => ({
        reloadAsync: vi.fn(),
    }));

    vi.mock('expo-router', async () => {
        const activeOptions = serverRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: vi.fn(),
                push: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
            params: {},
        }).module;
    });

    vi.mock('@/modal', async () => {
        const activeOptions = serverRouteModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/components/ui/lists/ItemList', () => ({
        ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
    }));

    vi.mock('@/components/ui/lists/ItemGroup', () => ({
        ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
    }));

    vi.mock('@/components/ui/lists/Item', () => ({
        Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
    }));

    vi.mock('@/components/ui/lists/ItemRowActions', () => ({
        ItemRowActions: ({ title, actions }: any) => React.createElement('ItemRowActions', { title, actions }),
    }));

    vi.mock('@/components/ui/buttons/RoundButton', () => ({
        RoundButton: (props: any) => React.createElement('RoundButton', props),
    }));

    vi.mock('@/components/ui/forms/Switch', () => ({
        Switch: (props: any) => React.createElement('Switch', props),
    }));
}
