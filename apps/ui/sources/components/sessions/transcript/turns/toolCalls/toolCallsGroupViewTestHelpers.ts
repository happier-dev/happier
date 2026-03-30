import { vi } from 'vitest';

type ToolCallsGroupModuleFactory = () => unknown | Promise<unknown>;
type ToolCallsGroupImportOriginal = <T = unknown>() => Promise<T>;
type ToolCallsGroupStorageModuleFactory = (
    importOriginal: ToolCallsGroupImportOriginal,
) => unknown | Promise<unknown>;

type InstallToolCallsGroupViewCommonModuleMocksOptions = Readonly<{
    icons?: ToolCallsGroupModuleFactory;
    reactNative?: ToolCallsGroupModuleFactory;
    storage?: ToolCallsGroupStorageModuleFactory;
    text?: ToolCallsGroupModuleFactory;
    unistyles?: ToolCallsGroupModuleFactory;
}>;

const toolCallsGroupViewCommonModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as ToolCallsGroupModuleFactory | undefined,
        reactNative: undefined as ToolCallsGroupModuleFactory | undefined,
        storage: undefined as ToolCallsGroupStorageModuleFactory | undefined,
        text: undefined as ToolCallsGroupModuleFactory | undefined,
        unistyles: undefined as ToolCallsGroupModuleFactory | undefined,
    },
}));

export function installToolCallsGroupViewCommonModuleMocks(
    options: InstallToolCallsGroupViewCommonModuleMocksOptions = {},
) {
    toolCallsGroupViewCommonModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = toolCallsGroupViewCommonModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = toolCallsGroupViewCommonModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = toolCallsGroupViewCommonModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = toolCallsGroupViewCommonModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = toolCallsGroupViewCommonModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });
}
