import { vi } from 'vitest';

type ServerSettingsHooksModuleFactory = () => unknown | Promise<unknown>;

type InstallServerSettingsHooksCommonModuleMocksOptions = Readonly<{
    modal?: ServerSettingsHooksModuleFactory;
    reactNative?: ServerSettingsHooksModuleFactory;
    router?: ServerSettingsHooksModuleFactory;
    storage?: ServerSettingsHooksModuleFactory;
    text?: ServerSettingsHooksModuleFactory;
}>;

const serverSettingsHooksModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as ServerSettingsHooksModuleFactory | undefined,
        reactNative: undefined as ServerSettingsHooksModuleFactory | undefined,
        router: undefined as ServerSettingsHooksModuleFactory | undefined,
        storage: undefined as ServerSettingsHooksModuleFactory | undefined,
        text: undefined as ServerSettingsHooksModuleFactory | undefined,
    },
}));

export function installServerSettingsHooksCommonModuleMocks(
    options: InstallServerSettingsHooksCommonModuleMocksOptions = {},
) {
    serverSettingsHooksModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = serverSettingsHooksModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = serverSettingsHooksModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = serverSettingsHooksModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = serverSettingsHooksModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = serverSettingsHooksModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage();
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
