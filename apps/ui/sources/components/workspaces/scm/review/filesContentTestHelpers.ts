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
    const activeOptions = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
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

    vi.doMock('@/modal', async () => {
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        filesContentModuleState.modalMockRef.current = modalMock;
        return modalMock.module;
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
