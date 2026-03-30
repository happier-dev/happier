import { vi } from 'vitest';

type SessionSettingsModuleFactory = () => unknown | Promise<unknown>;
type SessionSettingsImportOriginal = <T = unknown>() => Promise<T>;
type SessionSettingsStorageModuleFactory = (
    importOriginal: SessionSettingsImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionSettingsCommonModuleMocksOptions = Readonly<{
    modal?: SessionSettingsModuleFactory;
    reactNative?: SessionSettingsModuleFactory;
    storage?: SessionSettingsStorageModuleFactory;
    text?: SessionSettingsModuleFactory;
    unistyles?: SessionSettingsModuleFactory;
}>;

const sessionSettingsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as SessionSettingsModuleFactory | undefined,
        reactNative: undefined as SessionSettingsModuleFactory | undefined,
        storage: undefined as SessionSettingsStorageModuleFactory | undefined,
        text: undefined as SessionSettingsModuleFactory | undefined,
        unistyles: undefined as SessionSettingsModuleFactory | undefined,
    },
}));

export function resetSessionSettingsCommonModuleMockState() {
    sessionSettingsModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        storage: undefined,
        text: undefined,
        unistyles: undefined,
    };
}

export function installSessionSettingsCommonModuleMocks(
    options: InstallSessionSettingsCommonModuleMocksOptions = {},
) {
    sessionSettingsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionSettingsModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionSettingsModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = sessionSettingsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionSettingsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionSettingsModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
