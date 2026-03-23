import { vi } from 'vitest';

type FilesContentModuleFactory = () => unknown | Promise<unknown>;
type FilesContentImportOriginal = <T = unknown>() => Promise<T>;
type FilesContentStorageModuleFactory = (
    importOriginal: FilesContentImportOriginal,
) => unknown | Promise<unknown>;

type InstallFilesContentCommonModuleMocksOptions = Readonly<{
    modal?: FilesContentModuleFactory;
    reactNative?: FilesContentModuleFactory;
    storage?: FilesContentStorageModuleFactory;
    text?: FilesContentModuleFactory;
    unistyles?: FilesContentModuleFactory;
}>;

const filesContentModuleState = vi.hoisted(() => ({
    modalMockRef: { current: null as any },
    options: {
        modal: undefined as FilesContentModuleFactory | undefined,
        reactNative: undefined as FilesContentModuleFactory | undefined,
        storage: undefined as FilesContentStorageModuleFactory | undefined,
        text: undefined as FilesContentModuleFactory | undefined,
        unistyles: undefined as FilesContentModuleFactory | undefined,
    },
}));

export function getFilesContentModalMockRef() {
    return filesContentModuleState.modalMockRef as { current: any };
}

export function resetFilesContentCommonModuleMockState() {
    filesContentModuleState.modalMockRef.current = null;
}

export function installFilesContentCommonModuleMocks(
    options: InstallFilesContentCommonModuleMocksOptions = {},
) {
    filesContentModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = filesContentModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = filesContentModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = filesContentModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = filesContentModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        filesContentModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = filesContentModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
