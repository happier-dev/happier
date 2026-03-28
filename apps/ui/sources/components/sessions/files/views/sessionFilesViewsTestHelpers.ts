import { vi } from 'vitest';

type SessionFilesViewModuleFactory = () => unknown | Promise<unknown>;
type SessionFilesViewStorageFactory = (importOriginal: <T>() => Promise<T>) => unknown | Promise<unknown>;

type InstallSessionFilesViewCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionFilesViewModuleFactory;
    unistyles?: SessionFilesViewModuleFactory;
    text?: SessionFilesViewModuleFactory;
    modal?: SessionFilesViewModuleFactory;
    storage?: SessionFilesViewStorageFactory;
}>;

export function installSessionFilesViewCommonModuleMocks(
    options: InstallSessionFilesViewCommonModuleMocksOptions = {},
) {
    const activeOptions = options;

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
        return createTextModuleMock({ translate: (key) => key });
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

    vi.doMock('@/constants/Typography', () => ({
        Typography: {
            default: () => ({}),
            mono: () => ({}),
        },
    }));

    vi.doMock('@/components/ui/layout/layout', () => ({
        layout: { maxWidth: 1024 },
    }));
}
