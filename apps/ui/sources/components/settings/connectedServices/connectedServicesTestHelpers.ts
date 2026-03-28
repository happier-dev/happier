import { vi } from 'vitest';

import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';

type ConnectedServicesModuleFactory = () => unknown | Promise<unknown>;

type InstallConnectedServicesCommonModuleMocksOptions = Readonly<{
    modal?: ConnectedServicesModuleFactory;
    reactNative?: ConnectedServicesModuleFactory;
    router?: ConnectedServicesModuleFactory;
    searchParams?: ExpoRouterParams;
    text?: ConnectedServicesModuleFactory;
}>;

const connectedServicesModuleState = vi.hoisted(() => ({
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    searchParams: {} as ExpoRouterParams,
    options: {
        modal: undefined as ConnectedServicesModuleFactory | undefined,
        reactNative: undefined as ConnectedServicesModuleFactory | undefined,
        router: undefined as ConnectedServicesModuleFactory | undefined,
        text: undefined as ConnectedServicesModuleFactory | undefined,
    },
}));

export function resetConnectedServicesCommonModuleMockState() {
    connectedServicesModuleState.routerBackSpy.mockClear();
    connectedServicesModuleState.routerPushSpy.mockClear();
    connectedServicesModuleState.searchParams = {};
    connectedServicesModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        text: undefined,
    };
}

export function installConnectedServicesCommonModuleMocks(
    options: InstallConnectedServicesCommonModuleMocksOptions = {},
) {
    connectedServicesModuleState.searchParams = options.searchParams ?? {};
    connectedServicesModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                back: connectedServicesModuleState.routerBackSpy,
                push: connectedServicesModuleState.routerPushSpy,
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        });

        return {
            ...routerMock.module,
            useLocalSearchParams: () => connectedServicesModuleState.searchParams,
            useGlobalSearchParams: () => connectedServicesModuleState.searchParams,
        };
    });
}

export { connectedServicesModuleState };
