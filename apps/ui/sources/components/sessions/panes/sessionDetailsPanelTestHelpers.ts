import { vi } from 'vitest';

type SessionDetailsPanelModuleFactory = () => unknown | Promise<unknown>;
type SessionDetailsPanelImportOriginal = <T = unknown>() => Promise<T>;
type SessionDetailsPanelStorageModuleFactory = (
    importOriginal: SessionDetailsPanelImportOriginal,
) => unknown | Promise<unknown>;

type InstallSessionDetailsPanelCommonModuleMocksOptions = Readonly<{
    icons?: SessionDetailsPanelModuleFactory;
    reactNative?: SessionDetailsPanelModuleFactory;
    router?: false | SessionDetailsPanelModuleFactory;
    storage?: SessionDetailsPanelStorageModuleFactory;
    text?: SessionDetailsPanelModuleFactory;
    unistyles?: SessionDetailsPanelModuleFactory;
}>;

const sessionDetailsPanelModuleState = vi.hoisted(() => ({
    options: {
        icons: undefined as SessionDetailsPanelModuleFactory | undefined,
        reactNative: undefined as SessionDetailsPanelModuleFactory | undefined,
        router: undefined as false | SessionDetailsPanelModuleFactory | undefined,
        storage: undefined as SessionDetailsPanelStorageModuleFactory | undefined,
        text: undefined as SessionDetailsPanelModuleFactory | undefined,
        unistyles: undefined as SessionDetailsPanelModuleFactory | undefined,
    },
}));

export function installSessionDetailsPanelCommonModuleMocks(
    options: InstallSessionDetailsPanelCommonModuleMocksOptions = {},
) {
    sessionDetailsPanelModuleState.options = {
        icons: options.icons,
        reactNative: options.reactNative,
        router: options.router,
        storage: options.storage,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionDetailsPanelModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionDetailsPanelModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@expo/vector-icons', async () => {
        const activeOptions = sessionDetailsPanelModuleState.options;
        if (activeOptions.icons) {
            return await activeOptions.icons();
        }

        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    });

    if (options.router !== false) {
        vi.mock('expo-router', async () => {
            const activeOptions = sessionDetailsPanelModuleState.options;
            if (activeOptions.router) {
                return await activeOptions.router();
            }

            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({
                pathname: () => '/session/s1',
                router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
            }).module;
        });
    }

    vi.mock('@/components/ui/media/FileIcon', () => ({
        FileIcon: 'FileIcon',
    }));

    vi.mock('@/text', async () => {
        const activeOptions = sessionDetailsPanelModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionDetailsPanelModuleState.options;
        if (activeOptions.storage) {
            return await activeOptions.storage(importOriginal);
        }

        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {});
    });
}
