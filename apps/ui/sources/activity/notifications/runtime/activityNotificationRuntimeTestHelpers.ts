import { createTextModuleMock } from '@/dev/testkit/mocks/text';
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

export function createActivityNotificationTextModuleMock() {
    return createTextModuleMock({
        translate: (key: string) => {
            switch (key) {
                case 'notifications.activity.defaultSessionTitle':
                    return 'Session';
                case 'notifications.activity.readyFallbackBody':
                    return 'Turn finished. Open the session to continue.';
                case 'notifications.activity.permissionFallbackBody':
                    return 'Approval required.';
                case 'notifications.activity.userActionFallbackBody':
                    return 'This session needs your input.';
                default:
                    return key;
            }
        },
    });
}

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
