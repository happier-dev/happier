import { vi } from 'vitest';

type ActivityBadgeRuntimeModuleFactory = () => unknown | Promise<unknown>;
type ActivityBadgeRuntimeImportOriginal = <T = unknown>() => Promise<T>;
type ActivityBadgeRuntimeStorageModuleFactory = (
    importOriginal: ActivityBadgeRuntimeImportOriginal,
) => unknown | Promise<unknown>;

type InstallActivityBadgeRuntimeCommonModuleMocksOptions = Readonly<{
    reactNative?: ActivityBadgeRuntimeModuleFactory;
    storage?: ActivityBadgeRuntimeStorageModuleFactory;
}>;

const activityBadgeRuntimeModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ActivityBadgeRuntimeModuleFactory | undefined,
        storage: undefined as ActivityBadgeRuntimeStorageModuleFactory | undefined,
    },
}));

export function installActivityBadgeRuntimeCommonModuleMocks(
    options: InstallActivityBadgeRuntimeCommonModuleMocksOptions,
): void {
    activityBadgeRuntimeModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = activityBadgeRuntimeModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = activityBadgeRuntimeModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
