import { vi } from 'vitest';

type ToolShellPresentationModuleFactory = () => unknown | Promise<unknown>;
type ToolShellPresentationImportOriginal = <T = unknown>() => Promise<T>;
type ToolShellPresentationStorageModuleFactory = (
    importOriginal: ToolShellPresentationImportOriginal,
) => unknown | Promise<unknown>;

type InstallToolShellPresentationCommonModuleMocksOptions = Readonly<{
    icons?: ToolShellPresentationModuleFactory;
    reactNative?: ToolShellPresentationModuleFactory;
    storage?: ToolShellPresentationStorageModuleFactory;
    text?: ToolShellPresentationModuleFactory;
    unistyles?: ToolShellPresentationModuleFactory;
}>;

const toolShellPresentationModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as ToolShellPresentationModuleFactory | undefined,
        reactNative: undefined as ToolShellPresentationModuleFactory | undefined,
        storage: undefined as ToolShellPresentationStorageModuleFactory | undefined,
        text: undefined as ToolShellPresentationModuleFactory | undefined,
        unistyles: undefined as ToolShellPresentationModuleFactory | undefined,
    },
}));

export function installToolShellPresentationCommonModuleMocks(
    options: InstallToolShellPresentationCommonModuleMocksOptions = {},
) {
    toolShellPresentationModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = toolShellPresentationModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = toolShellPresentationModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = toolShellPresentationModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = toolShellPresentationModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = toolShellPresentationModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });
}
