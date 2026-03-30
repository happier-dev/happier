import { vi } from 'vitest';

type RepositoryTreeModuleFactory = () => unknown | Promise<unknown>;
type RepositoryTreeImportOriginal = <T = unknown>() => Promise<T>;
type RepositoryTreeStorageModuleFactory = (
    importOriginal: RepositoryTreeImportOriginal,
) => unknown | Promise<unknown>;

type InstallRepositoryTreeCommonModuleMocksOptions = Readonly<{
    modal?: RepositoryTreeModuleFactory;
    reactNative?: RepositoryTreeModuleFactory;
    storage?: RepositoryTreeStorageModuleFactory;
    text?: RepositoryTreeModuleFactory;
    typography?: RepositoryTreeModuleFactory;
    unistyles?: RepositoryTreeModuleFactory;
}>;

export function installRepositoryTreeCommonModuleMocks(
    options: InstallRepositoryTreeCommonModuleMocksOptions = {},
) {
    const activeOptions = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        typography: options.typography,
        unistyles: options.unistyles,
    };

    vi.doMock('react-native', async () => {
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.doMock('react-native-unistyles', async () => {
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.doMock('@/text', async () => {
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.doMock('@/constants/Typography', async () => {
        if (activeOptions.typography) {
            return await activeOptions.typography();
        }

        return {
            Typography: {
                default: () => ({}),
                mono: () => ({}),
            },
        };
    });

    vi.doMock('@/modal', async () => {
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.doMock('@/sync/domains/state/storage', async (importOriginal) => {
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {},
        });
    });
}
