import { vi } from 'vitest';

type RouteRootModuleFactory = () => unknown | Promise<unknown>;
type RouteRootImportOriginal = <T = unknown>() => Promise<T>;
type RouteRootStorageModuleFactory = (
    importOriginal: RouteRootImportOriginal,
) => unknown | Promise<unknown>;

type InstallRouteRootCommonModuleMocksOptions = Readonly<{
    modal?: RouteRootModuleFactory;
    reactNative?: RouteRootModuleFactory;
    router?: RouteRootModuleFactory;
    storage?: RouteRootStorageModuleFactory;
    text?: RouteRootModuleFactory;
    unistyles?: RouteRootModuleFactory;
}>;

const routeRootModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as RouteRootModuleFactory | undefined,
        reactNative: undefined as RouteRootModuleFactory | undefined,
        router: undefined as RouteRootModuleFactory | undefined,
        storage: undefined as RouteRootStorageModuleFactory | undefined,
        text: undefined as RouteRootModuleFactory | undefined,
        unistyles: undefined as RouteRootModuleFactory | undefined,
    },
}));

export function installRouteRootCommonModuleMocks(
    options: InstallRouteRootCommonModuleMocksOptions = {},
) {
    routeRootModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('@/modal', async () => {
        const activeOptions = routeRootModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = routeRootModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/text', async () => {
        const activeOptions = routeRootModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = routeRootModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = routeRootModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {},
        });
    });
}
