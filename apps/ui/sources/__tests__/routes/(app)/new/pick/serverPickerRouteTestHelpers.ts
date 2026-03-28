import { vi } from 'vitest';

type ServerPickerRouteModuleFactory = () => unknown | Promise<unknown>;
type ServerPickerRouteImportOriginal = <T = unknown>() => Promise<T>;
type ServerPickerRouteStorageModuleFactory = (
    importOriginal: ServerPickerRouteImportOriginal,
) => unknown | Promise<unknown>;

type InstallServerPickerRouteCommonModuleMocksOptions = Readonly<{
    icons?: ServerPickerRouteModuleFactory;
    reactNative?: ServerPickerRouteModuleFactory;
    router?: ServerPickerRouteModuleFactory;
    storage?: ServerPickerRouteStorageModuleFactory;
    text?: ServerPickerRouteModuleFactory;
    unistyles?: ServerPickerRouteModuleFactory;
}>;

const serverPickerRouteModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as ServerPickerRouteModuleFactory | undefined,
        reactNative: undefined as ServerPickerRouteModuleFactory | undefined,
        router: undefined as ServerPickerRouteModuleFactory | undefined,
        storage: undefined as ServerPickerRouteStorageModuleFactory | undefined,
        text: undefined as ServerPickerRouteModuleFactory | undefined,
        unistyles: undefined as ServerPickerRouteModuleFactory | undefined,
    },
}));

export function installServerPickerRouteCommonModuleMocks(
    options: InstallServerPickerRouteCommonModuleMocksOptions = {},
) {
    serverPickerRouteModuleState.options = {
        icons: options.icons,
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

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = serverPickerRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = serverPickerRouteModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = serverPickerRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = serverPickerRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});
}
