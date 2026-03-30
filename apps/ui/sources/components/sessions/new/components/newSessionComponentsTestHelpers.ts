import { vi } from 'vitest';

type NewSessionComponentsModuleFactory = () => unknown | Promise<unknown>;
type NewSessionComponentsImportOriginal = <T = unknown>() => Promise<T>;
type NewSessionComponentsStorageModuleFactory = (
    importOriginal: NewSessionComponentsImportOriginal,
) => unknown | Promise<unknown>;

type InstallNewSessionComponentsCommonModuleMocksOptions = Readonly<{
    icons?: NewSessionComponentsModuleFactory;
    modal?: NewSessionComponentsModuleFactory;
    reactNative?: NewSessionComponentsModuleFactory;
    router?: NewSessionComponentsModuleFactory;
    storage?: NewSessionComponentsStorageModuleFactory;
    text?: NewSessionComponentsModuleFactory;
    unistyles?: NewSessionComponentsModuleFactory;
}>;

const newSessionComponentsCommonModuleState = vi.hoisted(() => ({
    installed: false,
    options: {
        icons: undefined as NewSessionComponentsModuleFactory | undefined,
        modal: undefined as NewSessionComponentsModuleFactory | undefined,
        reactNative: undefined as NewSessionComponentsModuleFactory | undefined,
        router: undefined as NewSessionComponentsModuleFactory | undefined,
        storage: undefined as NewSessionComponentsStorageModuleFactory | undefined,
        text: undefined as NewSessionComponentsModuleFactory | undefined,
        unistyles: undefined as NewSessionComponentsModuleFactory | undefined,
    },
}));

export function installNewSessionComponentsCommonModuleMocks(
    options: InstallNewSessionComponentsCommonModuleMocksOptions = {},
) {
    newSessionComponentsCommonModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    // Many suites use this helper with suite-local overrides. The mocks themselves should be
    // installed exactly once per worker; subsequent calls just update the active override set.
    if (newSessionComponentsCommonModuleState.installed) {
        return;
    }
    newSessionComponentsCommonModuleState.installed = true;

    vi.mock('react-native', async () => {
        const activeOptions = newSessionComponentsCommonModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = newSessionComponentsCommonModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = newSessionComponentsCommonModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = newSessionComponentsCommonModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = newSessionComponentsCommonModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = newSessionComponentsCommonModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = newSessionComponentsCommonModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}

export function resetNewSessionComponentsCommonModuleMocks() {
    newSessionComponentsCommonModuleState.options = {
        icons: undefined,
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}
