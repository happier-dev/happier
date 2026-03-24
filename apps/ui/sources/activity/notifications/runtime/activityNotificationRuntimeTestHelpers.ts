import { vi } from 'vitest';

type ActivityNotificationRuntimeModuleFactory = () => unknown | Promise<unknown>;
type ActivityNotificationRuntimeImportOriginal = <T = unknown>() => Promise<T>;
type ActivityNotificationRuntimeStorageModuleFactory = (
    importOriginal: ActivityNotificationRuntimeImportOriginal,
) => unknown | Promise<unknown>;

type InstallActivityNotificationRuntimeCommonModuleMocksOptions = Readonly<{
    reactNative?: ActivityNotificationRuntimeModuleFactory;
    storage?: ActivityNotificationRuntimeStorageModuleFactory;
    text?: ActivityNotificationRuntimeModuleFactory;
}>;

const activityNotificationRuntimeModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as ActivityNotificationRuntimeModuleFactory | undefined,
        storage: undefined as ActivityNotificationRuntimeStorageModuleFactory | undefined,
        text: undefined as ActivityNotificationRuntimeModuleFactory | undefined,
    },
}));

export function installActivityNotificationRuntimeCommonModuleMocks(
    options: InstallActivityNotificationRuntimeCommonModuleMocksOptions = {},
): void {
    activityNotificationRuntimeModuleState.options = {
        reactNative: options.reactNative,
        storage: options.storage,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = activityNotificationRuntimeModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    });

    vi.mock('@/text', async () => {
        const activeOptions = activityNotificationRuntimeModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = activityNotificationRuntimeModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
