import { vi } from 'vitest';

type ConnectionStatusControlModuleFactory = () => unknown | Promise<unknown>;

type InstallConnectionStatusControlCommonModuleMocksOptions = Readonly<{
    reactNative?: ConnectionStatusControlModuleFactory;
    unistyles?: ConnectionStatusControlModuleFactory;
    text?: ConnectionStatusControlModuleFactory;
    storage?: ConnectionStatusControlModuleFactory;
    router?: ConnectionStatusControlModuleFactory;
    modal?: ConnectionStatusControlModuleFactory;
}>;

const connectionStatusControlModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ConnectionStatusControlModuleFactory | undefined,
        unistyles: undefined as ConnectionStatusControlModuleFactory | undefined,
        text: undefined as ConnectionStatusControlModuleFactory | undefined,
        storage: undefined as ConnectionStatusControlModuleFactory | undefined,
        router: undefined as ConnectionStatusControlModuleFactory | undefined,
        modal: undefined as ConnectionStatusControlModuleFactory | undefined,
    },
}));

export function installConnectionStatusControlCommonModuleMocks(
    options: InstallConnectionStatusControlCommonModuleMocksOptions = {},
) {
    connectionStatusControlModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        storage: options.storage,
        router: options.router,
        modal: options.modal,
    };

    vi.mock('react-native', async () => {
        const activeOptions = connectionStatusControlModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = connectionStatusControlModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = connectionStatusControlModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = connectionStatusControlModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('expo-router', async () => {
        const activeOptions = connectionStatusControlModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/modal', async () => {
        const activeOptions = connectionStatusControlModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
