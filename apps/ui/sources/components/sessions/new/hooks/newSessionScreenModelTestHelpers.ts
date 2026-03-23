import { vi } from 'vitest';

type NewSessionScreenModelModuleFactory = () => unknown | Promise<unknown>;
type NewSessionScreenModelImportOriginal = <T = unknown>() => Promise<T>;
type NewSessionScreenModelStorageModuleFactory = (
    importOriginal: NewSessionScreenModelImportOriginal,
) => unknown | Promise<unknown>;

type InstallNewSessionScreenModelCommonModuleMocksOptions = Readonly<{
    reactNative?: NewSessionScreenModelModuleFactory;
    unistyles?: NewSessionScreenModelModuleFactory;
    text?: NewSessionScreenModelModuleFactory;
    modal?: NewSessionScreenModelModuleFactory;
    router?: NewSessionScreenModelModuleFactory;
    storage?: NewSessionScreenModelStorageModuleFactory;
}>;

const newSessionScreenModelModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as NewSessionScreenModelModuleFactory | undefined,
        unistyles: undefined as NewSessionScreenModelModuleFactory | undefined,
        text: undefined as NewSessionScreenModelModuleFactory | undefined,
        modal: undefined as NewSessionScreenModelModuleFactory | undefined,
        router: undefined as NewSessionScreenModelModuleFactory | undefined,
        storage: undefined as NewSessionScreenModelStorageModuleFactory | undefined,
    },
}));

export function installNewSessionScreenModelCommonModuleMocks(
    options: InstallNewSessionScreenModelCommonModuleMocksOptions = {},
) {
    newSessionScreenModelModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        modal: options.modal,
        router: options.router,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = newSessionScreenModelModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
