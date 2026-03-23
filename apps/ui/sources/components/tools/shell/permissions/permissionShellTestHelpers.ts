import { vi } from 'vitest';

type PermissionShellModuleFactory = () => unknown | Promise<unknown>;
type PermissionShellImportOriginal = <T = unknown>() => Promise<T>;
type PermissionShellStorageModuleFactory = (importOriginal: PermissionShellImportOriginal) => unknown | Promise<unknown>;

type InstallPermissionShellCommonModuleMocksOptions = Readonly<{
    reactNative?: PermissionShellModuleFactory;
    unistyles?: PermissionShellModuleFactory;
    text?: PermissionShellModuleFactory;
    router?: PermissionShellModuleFactory;
    storage?: PermissionShellStorageModuleFactory;
}>;

const permissionShellModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as PermissionShellModuleFactory | undefined,
        unistyles: undefined as PermissionShellModuleFactory | undefined,
        text: undefined as PermissionShellModuleFactory | undefined,
        router: undefined as PermissionShellModuleFactory | undefined,
        storage: undefined as PermissionShellStorageModuleFactory | undefined,
    },
}));

export function installPermissionShellCommonModuleMocks(
    options: InstallPermissionShellCommonModuleMocksOptions = {},
) {
    permissionShellModuleState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        text: options.text,
        router: options.router,
        storage: options.storage,
    };

    vi.mock('react-native', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            TouchableOpacity: 'TouchableOpacity',
            ActivityIndicator: 'ActivityIndicator',
            Alert: {
                alert: vi.fn(),
            },
            Platform: {
                OS: 'ios',
                select: <T,>(value: { ios?: T; default?: T }) => value.ios ?? value.default,
            },
            StyleSheet: {
                create: <T,>(styles: T) => styles,
            },
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('expo-router', async () => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = permissionShellModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    });
}
