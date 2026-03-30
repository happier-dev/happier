import { vi } from 'vitest';

type SettingsViewModuleFactory = () => unknown | Promise<unknown>;
type SettingsViewImportOriginal = <T = unknown>() => Promise<T>;
type SettingsViewStorageModuleFactory = (
    importOriginal: SettingsViewImportOriginal,
) => unknown | Promise<unknown>;

type InstallSettingsViewCommonModuleMocksOptions = Readonly<{
    icons?: SettingsViewModuleFactory;
    modal?: SettingsViewModuleFactory;
    reactNative?: SettingsViewModuleFactory;
    router?: SettingsViewModuleFactory;
    storage?: SettingsViewStorageModuleFactory;
    text?: SettingsViewModuleFactory;
    unistyles?: SettingsViewModuleFactory;
}>;

const settingsViewModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SettingsViewModuleFactory | undefined,
        modal: undefined as SettingsViewModuleFactory | undefined,
        reactNative: undefined as SettingsViewModuleFactory | undefined,
        router: undefined as SettingsViewModuleFactory | undefined,
        storage: undefined as SettingsViewStorageModuleFactory | undefined,
        text: undefined as SettingsViewModuleFactory | undefined,
        unistyles: undefined as SettingsViewModuleFactory | undefined,
    },
}));

export function resetSettingsViewCommonModuleMockState() {
    settingsViewModuleState.options = {
        icons: undefined,
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installSettingsViewCommonModuleMocks(
    options: InstallSettingsViewCommonModuleMocksOptions = {},
) {
    settingsViewModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = settingsViewModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = settingsViewModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = settingsViewModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = settingsViewModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = settingsViewModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = settingsViewModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = settingsViewModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
