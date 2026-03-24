import { vi } from 'vitest';

type MarkdownModuleFactory = () => unknown | Promise<unknown>;

type InstallMarkdownCommonModuleMocksOptions = Readonly<{
    modal?: MarkdownModuleFactory;
    reactNative?: MarkdownModuleFactory;
    router?: MarkdownModuleFactory;
    storage?: MarkdownModuleFactory;
}>;

const markdownModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as MarkdownModuleFactory | undefined,
        reactNative: undefined as MarkdownModuleFactory | undefined,
        router: undefined as MarkdownModuleFactory | undefined,
        storage: undefined as MarkdownModuleFactory | undefined,
    },
}));

vi.mock('@/modal', async () => {
    const activeOptions = markdownModuleState.options;
    if (activeOptions.modal) {
        return await activeOptions.modal();
    }

    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('react-native', async () => {
    const activeOptions = markdownModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('expo-router', async () => {
    const activeOptions = markdownModuleState.options;
    if (activeOptions.router) {
        return await activeOptions.router();
    }

    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const activeOptions = markdownModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage();
    }

    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

export function installMarkdownCommonModuleMocks(
    options: InstallMarkdownCommonModuleMocksOptions = {},
): void {
    markdownModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
    };
}
