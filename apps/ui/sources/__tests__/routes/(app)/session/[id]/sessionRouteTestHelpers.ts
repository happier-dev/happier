import { vi } from 'vitest';

type SessionRouteModuleFactory = () => unknown | Promise<unknown>;
type SessionRouteImportOriginal = <T = unknown>() => Promise<T>;
type SessionRouteStorageModuleFactory = (
    importOriginal: SessionRouteImportOriginal,
) => unknown | Promise<unknown>;
type SessionRouteSafeAreaInsets = Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
}>;

type InstallSessionRouteCommonModuleMocksOptions = Readonly<{
    reactNative?: SessionRouteModuleFactory;
    router?: SessionRouteModuleFactory;
    unistyles?: SessionRouteModuleFactory;
    text?: SessionRouteModuleFactory;
    modal?: SessionRouteModuleFactory;
    storageModule?: SessionRouteStorageModuleFactory;
    safeAreaInsets?: () => SessionRouteSafeAreaInsets;
}>;

const sessionRouteModuleState = vi.hoisted(() => ({
    options: {} as InstallSessionRouteCommonModuleMocksOptions,
}));

export function installSessionRouteCommonModuleMocks(
    options: InstallSessionRouteCommonModuleMocksOptions = {},
) {
    sessionRouteModuleState.options = options;

    vi.mock('react-native', async () => {
        const activeOptions = sessionRouteModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = sessionRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: vi.fn(),
                push: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
            params: {
                id: 'session-1',
            },
        }).module;
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = sessionRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('react-native-safe-area-context', () => ({
        useSafeAreaInsets: () =>
            sessionRouteModuleState.options.safeAreaInsets?.() ?? { top: 0, right: 0, bottom: 0, left: 0 },
    }));

    vi.mock('@/text', async () => {
        const activeOptions = sessionRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = sessionRouteModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(),
                prompt: vi.fn(),
                show: vi.fn(),
            },
        }).module;
    });

    vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
        const activeOptions = sessionRouteModuleState.options;
        if (activeOptions.storageModule) {
            return await activeOptions.storageModule(importOriginal as SessionRouteImportOriginal);
        }

        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: { getState: () => ({}) } as any,
            },
        });
    });
}

export function getStyleValue(style: unknown, key: string): unknown {
    const styles = Array.isArray(style) ? style : [style];
    for (const entry of styles) {
        if (entry && typeof entry === 'object' && key in entry) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}
