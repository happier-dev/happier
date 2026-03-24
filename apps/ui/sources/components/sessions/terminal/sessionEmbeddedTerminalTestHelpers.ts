import { vi } from 'vitest';

type SessionEmbeddedTerminalModuleFactory = () => unknown | Promise<unknown>;
type SessionEmbeddedTerminalImportOriginal = <T = unknown>() => Promise<T>;
type SessionEmbeddedTerminalStorageModuleFactory = (
    importOriginal: SessionEmbeddedTerminalImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionEmbeddedTerminalCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionEmbeddedTerminalModuleFactory;
    storage?: SessionEmbeddedTerminalStorageModuleFactory;
    uiText?: SessionEmbeddedTerminalModuleFactory;
    unistyles?: SessionEmbeddedTerminalModuleFactory;
}>;

const sessionEmbeddedTerminalModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as SessionEmbeddedTerminalModuleFactory | undefined,
        storage: undefined as SessionEmbeddedTerminalStorageModuleFactory | undefined,
        uiText: undefined as SessionEmbeddedTerminalModuleFactory | undefined,
        unistyles: undefined as SessionEmbeddedTerminalModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = sessionEmbeddedTerminalModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = sessionEmbeddedTerminalModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const activeOptions = sessionEmbeddedTerminalModuleState.options;
    if (activeOptions.uiText) {
        return await activeOptions.uiText();
    }

    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const activeOptions = sessionEmbeddedTerminalModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage(importOriginal);
    }

    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

export function installSessionEmbeddedTerminalCommonModuleMocks(
    options: InstallSessionEmbeddedTerminalCommonModuleMocksOptions = {},
): void {
    sessionEmbeddedTerminalModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        uiText: options.uiText,
        unistyles: options.unistyles,
    };
}
