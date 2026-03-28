import { vi } from 'vitest';

type SearchRouteModuleFactory = () => unknown | Promise<unknown>;
type SearchRouteImportOriginal = <T = unknown>() => Promise<T>;
type SearchRouteStorageModuleFactory = (
    importOriginal: SearchRouteImportOriginal,
) => unknown | Promise<unknown>;

type InstallSearchRouteCommonModuleMocksOptions = Readonly<{
    reactNative?: SearchRouteModuleFactory;
    router?: SearchRouteModuleFactory;
    storage?: SearchRouteStorageModuleFactory;
    text?: SearchRouteModuleFactory;
    unistyles?: SearchRouteModuleFactory;
}>;

const searchRouteModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SearchRouteModuleFactory | undefined,
        router: undefined as SearchRouteModuleFactory | undefined,
        storage: undefined as SearchRouteStorageModuleFactory | undefined,
        text: undefined as SearchRouteModuleFactory | undefined,
        unistyles: undefined as SearchRouteModuleFactory | undefined,
    },
}));

export function installSearchRouteCommonModuleMocks(
    options: InstallSearchRouteCommonModuleMocksOptions = {},
) {
    searchRouteModuleState.options = {
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = searchRouteModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = searchRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = searchRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = searchRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = searchRouteModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });
}
