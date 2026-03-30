import { vi } from 'vitest';

type NewPickRouteModuleFactory = () => unknown | Promise<unknown>;
type NewPickRouteImportOriginal = <T = unknown>() => Promise<T>;
type NewPickRouteStorageModuleFactory = (
    importOriginal: NewPickRouteImportOriginal,
) => unknown | Promise<unknown>;

type InstallNewPickRouteCommonModuleMocksOptions = Readonly<{
    icons?: NewPickRouteModuleFactory;
    reactNative?: NewPickRouteModuleFactory;
    router?: NewPickRouteModuleFactory;
    storage?: NewPickRouteStorageModuleFactory;
    text?: NewPickRouteModuleFactory;
    unistyles?: NewPickRouteModuleFactory;
}>;

const newPickRouteModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as NewPickRouteModuleFactory | undefined,
        reactNative: undefined as NewPickRouteModuleFactory | undefined,
        router: undefined as NewPickRouteModuleFactory | undefined,
        storage: undefined as NewPickRouteStorageModuleFactory | undefined,
        text: undefined as NewPickRouteModuleFactory | undefined,
        unistyles: undefined as NewPickRouteModuleFactory | undefined,
    },
}));

export function installNewPickRouteCommonModuleMocks(
    options: InstallNewPickRouteCommonModuleMocksOptions = {},
) {
    newPickRouteModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native-reanimated', () => ({}));

    vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = newPickRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = newPickRouteModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = newPickRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = newPickRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = newPickRouteModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
