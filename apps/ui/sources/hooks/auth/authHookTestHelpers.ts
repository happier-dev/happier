import { vi } from 'vitest';

type AuthHookModuleFactory = () => unknown | Promise<unknown>;
type AuthHookImportOriginal = <T = unknown>() => Promise<T>;
type AuthHookStorageModuleFactory = (
    importOriginal: AuthHookImportOriginal,
) => unknown | Promise<unknown>;

type InstallAuthHookCommonModuleMocksOptions = Readonly<{
    modal?: AuthHookModuleFactory;
    reactNative?: AuthHookModuleFactory;
    router?: AuthHookModuleFactory;
    storage?: AuthHookStorageModuleFactory;
    text?: AuthHookModuleFactory;
}>;

const authHookModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as AuthHookModuleFactory | undefined,
        reactNative: undefined as AuthHookModuleFactory | undefined,
        router: undefined as AuthHookModuleFactory | undefined,
        storage: undefined as AuthHookStorageModuleFactory | undefined,
        text: undefined as AuthHookModuleFactory | undefined,
    },
}));

export function installAuthHookCommonModuleMocks(
    options: InstallAuthHookCommonModuleMocksOptions = {},
) {
    authHookModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = authHookModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = authHookModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = authHookModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = authHookModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });

    vi.mock('@/text', async () => {
        const activeOptions = authHookModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });
}
