import { vi } from 'vitest';

type SessionHooksModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionHooksCommonModuleMocksOptions = Readonly<{
    modal?: SessionHooksModuleFactory;
    reactNative?: SessionHooksModuleFactory;
    router?: SessionHooksModuleFactory;
    text?: SessionHooksModuleFactory;
}>;

const sessionHooksModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SessionHooksModuleFactory | undefined,
        reactNative: undefined as SessionHooksModuleFactory | undefined,
        router: undefined as SessionHooksModuleFactory | undefined,
        text: undefined as SessionHooksModuleFactory | undefined,
    },
}));

export function installSessionHooksCommonModuleMocks(
    options: InstallSessionHooksCommonModuleMocksOptions = {},
) {
    sessionHooksModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionHooksModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionHooksModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionHooksModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionHooksModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });
}
