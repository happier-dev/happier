import { vi } from 'vitest';

type CodeDiffModuleFactory = () => unknown | Promise<unknown>;
type CodeDiffImportOriginal = <T = unknown>() => Promise<T>;
type CodeDiffStorageModuleFactory = (importOriginal: CodeDiffImportOriginal) => unknown | Promise<unknown>;

type InstallCodeDiffCommonModuleMocksOptions = Readonly<{
    reactNative?: CodeDiffModuleFactory;
    storage?: CodeDiffStorageModuleFactory;
    text?: CodeDiffModuleFactory;
    unistyles?: CodeDiffModuleFactory;
}>;

const codeDiffModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as CodeDiffModuleFactory | undefined,
        storage: undefined as CodeDiffStorageModuleFactory | undefined,
        text: undefined as CodeDiffModuleFactory | undefined,
        unistyles: undefined as CodeDiffModuleFactory | undefined,
    },
}));

export function installCodeDiffCommonModuleMocks(
    options: InstallCodeDiffCommonModuleMocksOptions = {},
) {
    codeDiffModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = codeDiffModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = codeDiffModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });

    vi.mock('@/text', async () => {
        const activeOptions = codeDiffModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = codeDiffModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });
}
