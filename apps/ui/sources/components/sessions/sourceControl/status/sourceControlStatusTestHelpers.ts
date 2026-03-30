import { vi } from 'vitest';

type SourceControlStatusModuleFactory = () => unknown | Promise<unknown>;
type SourceControlStatusImportOriginal = <T = unknown>() => Promise<T>;
type SourceControlStatusStorageModuleFactory = (
    importOriginal: SourceControlStatusImportOriginal,
) => unknown | Promise<unknown>;

type InstallSourceControlStatusCommonModuleMocksOptions = Readonly<{
    icons?: SourceControlStatusModuleFactory;
    reactNative?: SourceControlStatusModuleFactory;
    storage?: SourceControlStatusStorageModuleFactory;
    text?: SourceControlStatusModuleFactory;
    unistyles?: SourceControlStatusModuleFactory;
}>;

const sourceControlStatusModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SourceControlStatusModuleFactory | undefined,
        reactNative: undefined as SourceControlStatusModuleFactory | undefined,
        storage: undefined as SourceControlStatusStorageModuleFactory | undefined,
        text: undefined as SourceControlStatusModuleFactory | undefined,
        unistyles: undefined as SourceControlStatusModuleFactory | undefined,
    },
}));

export function installSourceControlStatusCommonModuleMocks(
    options: InstallSourceControlStatusCommonModuleMocksOptions = {},
) {
    sourceControlStatusModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sourceControlStatusModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sourceControlStatusModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sourceControlStatusModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    vi.mock('@/components/ui/text/Text', () => ({
        Text: 'Text',
    }));

    vi.mock('@/text', async () => {
        const activeOptions = sourceControlStatusModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sourceControlStatusModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
