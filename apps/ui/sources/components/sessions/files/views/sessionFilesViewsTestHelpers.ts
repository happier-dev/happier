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

const sessionFilesViewsModuleState = vi.hoisted(() => ({
    options: {} as InstallSessionFilesViewCommonModuleMocksOptions,
}));

export function installSessionFilesViewCommonModuleMocks(
    options: InstallSessionFilesViewCommonModuleMocksOptions = {},
) {
    sessionFilesViewsModuleState.options = options;

    vi.mock('react-native', async () => {
        const activeOptions = sessionFilesViewsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionFilesViewsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionFilesViewsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionFilesViewsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionFilesViewsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {},
        });
    });

    vi.mock('@/constants/Typography', () => ({
        Typography: {
            default: () => ({}),
            mono: () => ({}),
        },
    }));

    vi.mock('@/components/ui/layout/layout', () => ({
        layout: { maxWidth: 1024 },
    }));
}
