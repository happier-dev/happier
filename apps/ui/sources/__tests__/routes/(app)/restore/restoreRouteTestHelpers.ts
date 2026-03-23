import { vi } from 'vitest';

type ModuleFactory = () => unknown | Promise<unknown>;

type InstallRestoreRouteModuleMocksOptions = Readonly<{
    reactNative?: ModuleFactory;
    router?: ModuleFactory;
    modal?: ModuleFactory;
    text?: ModuleFactory;
    unistyles?: ModuleFactory;
}>;

const restoreRouteTestState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ModuleFactory | undefined,
        router: undefined as ModuleFactory | undefined,
        modal: undefined as ModuleFactory | undefined,
        text: undefined as ModuleFactory | undefined,
        unistyles: undefined as ModuleFactory | undefined,
    },
}));

export function resetRestoreRouteTestState() {
    restoreRouteTestState.options = {
        reactNative: undefined,
        router: undefined,
        modal: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installRestoreRouteCommonModuleMocks(
    options: InstallRestoreRouteModuleMocksOptions = {},
) {
    restoreRouteTestState.options = {
        reactNative: options.reactNative,
        router: options.router,
        modal: options.modal,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native-reanimated', () => ({}));

    vi.mock('react-native', async () => {
        if (restoreRouteTestState.options.reactNative) {
            return await restoreRouteTestState.options.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        if (restoreRouteTestState.options.router) {
            return await restoreRouteTestState.options.router();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/modal', async () => {
        if (restoreRouteTestState.options.modal) {
            return await restoreRouteTestState.options.modal();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/text', async () => {
        if (restoreRouteTestState.options.text) {
            return await restoreRouteTestState.options.text();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        if (restoreRouteTestState.options.unistyles) {
            return await restoreRouteTestState.options.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
