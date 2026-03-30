import { vi } from 'vitest';

type MediaModuleFactory = () => unknown | Promise<unknown>;
type MediaImportOriginal = <T = unknown>() => Promise<T>;
type MediaStorageModuleFactory = (importOriginal: MediaImportOriginal) => unknown | Promise<unknown>;

type InstallMediaCommonModuleMocksOptions = Readonly<{
    reactNative?: MediaModuleFactory;
    storage?: MediaStorageModuleFactory;
    unistyles?: MediaModuleFactory;
}>;

const mediaModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as MediaModuleFactory | undefined,
        storage: undefined as MediaStorageModuleFactory | undefined,
        unistyles: undefined as MediaModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const activeOptions = mediaModuleState.options;
    if (activeOptions.reactNative) {
        return await activeOptions.reactNative();
    }

    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = mediaModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const activeOptions = mediaModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage(importOriginal);
    }

    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

export function installMediaCommonModuleMocks(
    options: InstallMediaCommonModuleMocksOptions = {},
): void {
    mediaModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        unistyles: options.unistyles,
    };
}
