import { vi } from 'vitest';

type PendingMessagesModuleFactory = () => unknown | Promise<unknown>;
type PendingMessagesImportOriginal = <T = unknown>() => Promise<T>;
type PendingMessagesStorageModuleFactory = (
    importOriginal: PendingMessagesImportOriginal,
) => unknown | Promise<unknown>;

type InstallPendingMessagesCommonModuleMocksOptions = Readonly<{
    icons?: PendingMessagesModuleFactory;
    modal?: PendingMessagesModuleFactory;
    reactNative?: PendingMessagesModuleFactory;
    storage?: PendingMessagesStorageModuleFactory;
    typography?: PendingMessagesModuleFactory;
    unistyles?: PendingMessagesModuleFactory;
}>;

const pendingMessagesModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as PendingMessagesModuleFactory | undefined,
        modal: undefined as PendingMessagesModuleFactory | undefined,
        reactNative: undefined as PendingMessagesModuleFactory | undefined,
        storage: undefined as PendingMessagesStorageModuleFactory | undefined,
        typography: undefined as PendingMessagesModuleFactory | undefined,
        unistyles: undefined as PendingMessagesModuleFactory | undefined,
    },
}));

export function installPendingMessagesCommonModuleMocks(
    options: InstallPendingMessagesCommonModuleMocksOptions = {},
) {
    pendingMessagesModuleState.options = {
        icons: options.icons,
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        typography: options.typography,
        unistyles: options.unistyles,
    };

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = pendingMessagesModuleState.options;
        if (activeOptions.typography) {
            return await activeOptions.typography();
        }

        return {
            Typography: {
                default: () => ({}),
            },
        };
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = pendingMessagesModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/modal', async () => {
        const activeOptions = pendingMessagesModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('react-native', async () => {
        const activeOptions = pendingMessagesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = pendingMessagesModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = pendingMessagesModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });
}
