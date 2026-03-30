import { vi } from 'vitest';

type AcpCatalogSettingsModuleFactory = () => unknown | Promise<unknown>;
type AcpCatalogSettingsImportOriginal = <T = unknown>() => Promise<T>;
type AcpCatalogSettingsStorageModuleFactory = (
    importOriginal: AcpCatalogSettingsImportOriginal,
) => unknown | Promise<unknown>;

type InstallAcpCatalogSettingsCommonModuleMocksOptions = Readonly<{
    icons?: AcpCatalogSettingsModuleFactory;
    modal?: AcpCatalogSettingsModuleFactory;
    reactNative?: AcpCatalogSettingsModuleFactory;
    router?: AcpCatalogSettingsModuleFactory;
    storage?: AcpCatalogSettingsStorageModuleFactory;
    text?: AcpCatalogSettingsModuleFactory;
    unistyles?: AcpCatalogSettingsModuleFactory;
}>;

const acpCatalogSettingsModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as AcpCatalogSettingsModuleFactory | undefined,
        modal: undefined as AcpCatalogSettingsModuleFactory | undefined,
        reactNative: undefined as AcpCatalogSettingsModuleFactory | undefined,
        router: undefined as AcpCatalogSettingsModuleFactory | undefined,
        storage: undefined as AcpCatalogSettingsStorageModuleFactory | undefined,
        text: undefined as AcpCatalogSettingsModuleFactory | undefined,
        unistyles: undefined as AcpCatalogSettingsModuleFactory | undefined,
    },
}));

export function installAcpCatalogSettingsCommonModuleMocks(
    options: InstallAcpCatalogSettingsCommonModuleMocksOptions = {},
) {
    acpCatalogSettingsModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = acpCatalogSettingsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = acpCatalogSettingsModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = acpCatalogSettingsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = acpCatalogSettingsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = acpCatalogSettingsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = acpCatalogSettingsModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = acpCatalogSettingsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
