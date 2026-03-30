import { vi } from 'vitest';

type SessionShellModuleFactory = () => unknown | Promise<unknown>;
type SessionShellImportOriginal = <T = unknown>() => Promise<T>;
type SessionShellStorageModuleFactory = (importOriginal: SessionShellImportOriginal) => unknown | Promise<unknown>;

type InstallSessionShellCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionShellModuleFactory;
    unistyles?: SessionShellModuleFactory;
    text?: SessionShellModuleFactory;
    modal?: SessionShellModuleFactory;
    router?: SessionShellModuleFactory;
    storage?: SessionShellStorageModuleFactory;
}>;

const sessionShellModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionShellModuleFactory | undefined,
        unistyles: undefined as SessionShellModuleFactory | undefined,
        text: undefined as SessionShellModuleFactory | undefined,
        modal: undefined as SessionShellModuleFactory | undefined,
        router: undefined as SessionShellModuleFactory | undefined,
        storage: undefined as SessionShellStorageModuleFactory | undefined,
    },
}));

export function installSessionShellCommonModuleMocks(
    options: InstallSessionShellCommonModuleMocksOptions = {},
) {
    sessionShellModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        modal: options.modal,
        router: options.router,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionShellModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
