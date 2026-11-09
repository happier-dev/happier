import { afterEach, beforeEach, vi } from 'vitest';
import type { PropsWithChildren, ReactElement } from 'react';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit/render/renderWithAppProviders';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

/** Mounted app Settings entry, unlike the generic layout/search-only renderer. */
export async function renderSessionSettingsEntryView(element: ReactElement, options: RenderWithAppProvidersOptions = {}) {
    await loadSyncSingletonForTests();
    const React = await import('react');
    const { AuthProvider, useOptionalAuth } = await import('@/auth/context/AuthContext');
    const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
    const CallerWrapper = options.wrapper;
    function EntryAuthBoundary({ children }: PropsWithChildren) {
        const auth = useOptionalAuth();
        // Account fixtures retain their own real provider and captured lifetime.
        return auth ? React.createElement(React.Fragment, null, children)
            : React.createElement(AuthProvider, { initialCredentials: null, children });
    }
    function EntryProviders({ children }: PropsWithChildren) {
        const content = React.createElement(EntryAuthBoundary, { children });
        return CallerWrapper ? React.createElement(CallerWrapper, { children: content }) : content;
    }
    const screen = await renderSettingsView(element, { ...options, wrapper: EntryProviders });
    return screen;
}

type SettingsEntryModuleFactory = () => unknown | Promise<unknown>;

type InstallSessionSettingsEntryModuleMocksOptions = Readonly<{
    reactNative?: SettingsEntryModuleFactory;
    unistyles?: SettingsEntryModuleFactory;
    routerModule?: SettingsEntryModuleFactory;
    textModule?: SettingsEntryModuleFactory;
    modalModule?: SettingsEntryModuleFactory;
}>;

const sessionSettingsEntryState = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    settingsState: {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
        sessionListLayoutV1: 'projects',
    } as Record<string, unknown>,
    options: {
        reactNative: undefined as SettingsEntryModuleFactory | undefined,
        unistyles: undefined as SettingsEntryModuleFactory | undefined,
        routerModule: undefined as SettingsEntryModuleFactory | undefined,
        textModule: undefined as SettingsEntryModuleFactory | undefined,
        modalModule: undefined as SettingsEntryModuleFactory | undefined,
    },
}));

export function resetSessionSettingsEntryState() {
    sessionSettingsEntryState.routerPushSpy.mockClear();
    sessionSettingsEntryState.settingsState = {
        sessionsRightPaneDefaultOpen: false,
        uiMultiPanePanelsEnabled: false,
        sessionListLayoutV1: 'projects',
    };
    // SDK factories belong to the installed file fixture, not one mounted
    // screen. Re-importing a route must retain its declared viewport/native ports.
}

// Register before consumer hooks, including suites which configure SDK options
// in their own beforeEach. Reverse teardown leaves the ports up for Account disposal.
let browser: Awaited<ReturnType<typeof import('@/dev/testkit/harness/browserRuntimeHarness')['installBrowserRuntimeForTests']>> | undefined;
beforeEach(async () => {
    browser = await (await import('@/dev/testkit/harness/browserRuntimeHarness')).installBrowserRuntimeForTests({
        url: 'https://ui.fixture.test/settings',
    });
});
afterEach(() => {
    browser?.restore();
    browser = undefined;
});

export function installSessionSettingsEntryModuleMocks(
    options: InstallSessionSettingsEntryModuleMocksOptions = {},
) {
    sessionSettingsEntryState.options = {
        reactNative: options.reactNative,
        unistyles: options.unistyles,
        routerModule: options.routerModule,
        textModule: options.textModule,
        modalModule: options.modalModule,
    };

    vi.mock('react-native', async () => {
        const activeOptions = sessionSettingsEntryState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@expo/vector-icons', async () =>
        (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

    vi.mock('react-native-unistyles', async () => {
        if (sessionSettingsEntryState.options.unistyles) {
            return await sessionSettingsEntryState.options.unistyles();
        }
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('expo-router', async () => {
        if (sessionSettingsEntryState.options.routerModule) {
            return await sessionSettingsEntryState.options.routerModule();
        }
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: sessionSettingsEntryState.routerPushSpy,
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    });

    vi.mock('@/text', async () => {
        if (sessionSettingsEntryState.options.textModule) {
            return await sessionSettingsEntryState.options.textModule();
        }
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });

    vi.mock('@/modal', async () => {
        if (sessionSettingsEntryState.options.modalModule) {
            return await sessionSettingsEntryState.options.modalModule();
        }
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

}

export { sessionSettingsEntryState };
