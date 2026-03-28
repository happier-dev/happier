import { vi } from 'vitest';

type MessageViewModuleFactory = () => unknown | Promise<unknown>;
type MessageViewImportOriginal = <T = unknown>() => Promise<T>;
type MessageViewStorageModuleFactory = (importOriginal: MessageViewImportOriginal) => unknown | Promise<unknown>;

type InstallMessageViewCommonModuleMocksOptions = Readonly<{
    reactNative?: MessageViewModuleFactory;
    unistyles?: MessageViewModuleFactory;
    text?: MessageViewModuleFactory;
    modal?: MessageViewModuleFactory;
    router?: MessageViewModuleFactory;
    storage?: MessageViewStorageModuleFactory;
}>;

const messageViewCommonModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as MessageViewModuleFactory | undefined,
        unistyles: undefined as MessageViewModuleFactory | undefined,
        text: undefined as MessageViewModuleFactory | undefined,
        modal: undefined as MessageViewModuleFactory | undefined,
        router: undefined as MessageViewModuleFactory | undefined,
        storage: undefined as MessageViewStorageModuleFactory | undefined,
    },
}));

export function installMessageViewCommonModuleMocks(
    options: InstallMessageViewCommonModuleMocksOptions = {},
) {
    messageViewCommonModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        modal: options.modal,
        router: options.router,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = messageViewCommonModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = messageViewCommonModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = messageViewCommonModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = messageViewCommonModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = messageViewCommonModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = messageViewCommonModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });
}
