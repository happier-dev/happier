import { vi } from 'vitest';

type AvatarModuleFactory = () => unknown | Promise<unknown>;
type AvatarImportOriginal = <T = unknown>() => Promise<T>;
type AvatarStorageModuleFactory = (importOriginal: AvatarImportOriginal) => unknown | Promise<unknown>;

type InstallAvatarCommonModuleMocksOptions = Readonly<{
    reactNative?: AvatarModuleFactory;
    storage?: AvatarStorageModuleFactory;
    unistyles?: AvatarModuleFactory;
}>;

const avatarModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as AvatarModuleFactory | undefined,
        storage: undefined as AvatarStorageModuleFactory | undefined,
        unistyles: undefined as AvatarModuleFactory | undefined,
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const activeOptions = avatarModuleState.options;
    if (activeOptions.unistyles) {
        return await activeOptions.unistyles();
    }

    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const activeOptions = avatarModuleState.options;
    if (activeOptions.storage) {
        return await activeOptions.storage(importOriginal);
    }

    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

export function installAvatarCommonModuleMocks(
    options: InstallAvatarCommonModuleMocksOptions = {},
): void {
    avatarModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        unistyles: options.unistyles,
    };
}
