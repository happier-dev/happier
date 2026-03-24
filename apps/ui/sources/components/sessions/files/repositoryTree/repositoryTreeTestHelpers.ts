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

const repositoryTreeModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as RepositoryTreeModuleFactory | undefined,
        reactNative: undefined as RepositoryTreeModuleFactory | undefined,
        storage: undefined as RepositoryTreeStorageModuleFactory | undefined,
        text: undefined as RepositoryTreeModuleFactory | undefined,
        typography: undefined as RepositoryTreeModuleFactory | undefined,
        unistyles: undefined as RepositoryTreeModuleFactory | undefined,
    },
}));

export function installRepositoryTreeCommonModuleMocks(
    options: InstallRepositoryTreeCommonModuleMocksOptions = {},
) {
    repositoryTreeModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        typography: options.typography,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = repositoryTreeModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = repositoryTreeModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = repositoryTreeModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/constants/Typography', async () => {
        const activeOptions = repositoryTreeModuleState.options;
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

    vi.mock('@/modal', async () => {
        const activeOptions = repositoryTreeModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = repositoryTreeModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
