import { vi } from 'vitest';

type AuthHookModuleFactory = () => unknown | Promise<unknown>;

type InstallAuthHookCommonModuleMocksOptions = Readonly<{
    modal?: AuthHookModuleFactory;
    reactNative?: AuthHookModuleFactory;
    router?: AuthHookModuleFactory;
    storage?: AuthHookModuleFactory;
    text?: AuthHookModuleFactory;
}>;

const authHookModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as AuthHookModuleFactory | undefined,
        reactNative: undefined as AuthHookModuleFactory | undefined,
        router: undefined as AuthHookModuleFactory | undefined,
        storage: undefined as AuthHookModuleFactory | undefined,
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

    vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
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
