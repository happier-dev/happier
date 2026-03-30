import { vi } from 'vitest';

type SessionFilesModuleFactory = () => unknown | Promise<unknown>;
type SessionFilesImportOriginal = <T = unknown>() => Promise<T>;
type SessionFilesStorageModuleFactory = (importOriginal: SessionFilesImportOriginal) => unknown | Promise<unknown>;

type InstallSessionFilesHookCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionFilesModuleFactory;
    text?: SessionFilesModuleFactory;
    modal?: SessionFilesModuleFactory;
    storage?: SessionFilesStorageModuleFactory;
}>;

const sessionFilesHookModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionFilesModuleFactory | undefined,
        text: undefined as SessionFilesModuleFactory | undefined,
        modal: undefined as SessionFilesModuleFactory | undefined,
        storage: undefined as SessionFilesStorageModuleFactory | undefined,
    },
}));

export function installSessionFilesHookCommonModuleMocks(
    options: InstallSessionFilesHookCommonModuleMocksOptions = {},
) {
    sessionFilesHookModuleState.options = {
        reactNative: options.reactNative,
        text: options.text,
        modal: options.modal,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionFilesHookModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionFilesHookModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionFilesHookModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async () => {
        const activeOptions = sessionFilesHookModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(async <T = unknown>() => await vi.importActual<T>('@/sync/domains/state/storage'));
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return await createPartialStorageModuleMock(
            async <T = unknown>() => await vi.importActual<T>('@/sync/domains/state/storage'),
            {},
        );
    });
}
