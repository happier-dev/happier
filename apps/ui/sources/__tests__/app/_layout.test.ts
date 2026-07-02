import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

type NativeChildrenProps = React.PropsWithChildren<Record<string, unknown>>;
type PlatformSelectOptions<T> = {
    web?: T;
    ios?: T;
    default?: T;
};

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
}));
const notificationNativeState = vi.hoisted(() => ({
    unavailable: false,
}));
const tauriDesktopState = vi.hoisted(() => ({
    value: false,
}));
const invokeTauriSpy = vi.hoisted(() => vi.fn());

let isAuthenticated = true;
let segments: string[] = ['(app)'];
let pathname = '/';
let endpointConnectivityStatus: 'idle' | 'offline' | 'connecting' | 'online' | 'auth_failed' | 'shutting_down' = 'online';
let syncErrorState: null | {
    message: string;
    retryable: boolean;
    kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    at: number;
    serverId?: string;
} = null;
let activeServerId = 'server-active';
let globalSearchParamsState: Record<string, string | string[] | undefined> = {};
let stackNavigatorScreenOptionsHistory: unknown[] = [];

const router = { replace: vi.fn(), push: vi.fn() };
type NotificationResponsePayload = {
    actionIdentifier: string;
    notification: {
        request: {
            content: {
                data: {
                    url?: string;
                };
            };
        };
    };
};
let lastNotificationResponse: NotificationResponsePayload | null = null;

const stableFeaturesResponse = {
    features: {
        bugReports: {
            enabled: true,
            providerUrl: 'https://reports.happier.dev',
            defaultIncludeDiagnostics: true,
            maxArtifactBytes: 10485760,
            acceptedArtifactKinds: ['ui-mobile', 'ui-desktop', 'cli', 'daemon', 'server', 'stack-service', 'user-note'],
            uploadTimeoutMs: 120000,
        },
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
        voice: { enabled: true, configured: false, provider: null },
        social: { friends: { enabled: false, allowUsername: false, requiredIdentityProviderId: null } },
        oauth: { providers: { github: { enabled: false, configured: false } } },
        auth: {
            signup: { methods: [{ id: 'anonymous', enabled: true }] },
            login: { requiredProviders: [] },
            providers: {},
            misconfig: [],
        },
    },
};

function stubFeatureFetch() {
    const fetchMock: typeof fetch = (async () => ({
        ok: true,
        json: async () => stableFeaturesResponse,
    })) as unknown as typeof fetch;
    vi.stubGlobal(
        'fetch',
        vi.fn(fetchMock),
    );
}

vi.mock('react-native-reanimated', () => ({}));

vi.mock('socket.io-client', () => {
    const socket = {
        connected: false,
        connect: vi.fn(function connect(this: { connected: boolean }) {
            this.connected = true;
        }),
        on: vi.fn(),
        onAny: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
        disconnect: vi.fn(),
        removeAllListeners: vi.fn(),
    };

    return {
        io: vi.fn(() => socket),
        Socket: class Socket {},
    };
});

vi.mock('expo-notifications', () => {
    if (notificationNativeState.unavailable) {
        throw new Error('expo-notifications native module unavailable');
    }
    return {
        DEFAULT_ACTION_IDENTIFIER: 'default',
        getLastNotificationResponseAsync: vi.fn(async () => lastNotificationResponse),
        addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
    };
});

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return {
        Ionicons: (props: NativeChildrenProps) => React.createElement('Ionicons', props, props.children),
    };
});

vi.mock('@/components/navigation/Header', () => {
    return { createHeader: () => null };
});

vi.mock('@/constants/Typography', () => {
    return {
        Typography: {
            default: () => ({}),
            header: () => ({}),
            mono: () => ({}),
        },
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => true,
}));

vi.mock('@/components/navigation/mobile/chrome/MobileBottomChromeHost', () => ({
    MobileBottomChromeHost: () => React.createElement('MobileBottomChromeHost'),
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', () => ({
    MainAppTabStateProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/activity/badges/ActivityBadgeRuntime', () => ({
    ActivityBadgeRuntime: () => null,
}));

vi.mock('@/activity/adapters/ios/runtime/ActivitySurfacesRuntime', () => ({
    ActivitySurfacesRuntime: () => React.createElement('ActivitySurfacesRuntime'),
}));

vi.mock('@/activity/notifications/runtime/ActivityLocalNotificationRuntime', () => ({
    ActivityLocalNotificationRuntime: () => null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: (props: NativeChildrenProps) => React.createElement('View', props, props.children),
                                    ScrollView: (props: NativeChildrenProps) => React.createElement('ScrollView', props, props.children),
                                    Pressable: (props: NativeChildrenProps) => React.createElement('Pressable', props, props.children),
                                    TextInput: (props: NativeChildrenProps) => React.createElement('TextInput', props, props.children),
                                    ActivityIndicator: (props: NativeChildrenProps) => React.createElement('ActivityIndicator', props, props.children),
                                    Platform: {
                                        get OS() {
                                            return platformState.os;
                                        },
                                        select: <T,>(options: PlatformSelectOptions<T>) => (
                                            platformState.os === 'web'
                                                ? options.web ?? options.default
                                                : options.ios ?? options.default
                                        ),
                                    },
                                    Dimensions: {
                                        get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
                                    },
                                    InteractionManager: {
                                        runAfterInteractions: (fn: () => void) => fn(),
                                    },
                                    StyleSheet: {
                                        create: <T,>(styles: T) => styles,
                                    },
                                    useWindowDimensions: () => ({ width: 800, height: 600 }),
                                    processColor: <T,>(value: T) => value,
                                    AppState: {
                                        addEventListener: () => ({ remove: () => {} }),
                                    },
                                    TouchableOpacity: (props: NativeChildrenProps) => React.createElement('TouchableOpacity', props, props.children),
                                    Text: (props: NativeChildrenProps) => React.createElement('Text', props, props.children),
                                }
    );
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: router,
        pathname: () => {
            React.useMemo(() => 0, [pathname]);
            return pathname;
        },
        params: () => globalSearchParamsState,
        segments: () => {
            React.useMemo(() => 0, [segments.join('|')]);
            return segments;
        },
    });
    const BaseStack = expoRouterMock.module.Stack;
    const Stack = Object.assign(
        (props: React.PropsWithChildren<{ screenOptions?: unknown }>) => {
            stackNavigatorScreenOptionsHistory.push(props.screenOptions);
            return React.createElement(React.Fragment, null, props.children ?? null);
        },
        {
            Screen: BaseStack.Screen,
        },
    );
    return {
        ...expoRouterMock.module,
        Stack,
    };
});

vi.mock('@/auth/context/AuthContext', () => {
    const React = require('react');
    return {
        useAuth: () => {
            React.useMemo(() => 0, [isAuthenticated]);
            return { isAuthenticated };
        },
    };
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useProfile: () => ({
            linkedProviders: [],
            username: null,
        }),
        useLocalSettings: () => ({}),
        useEndpointConnectivity: () => ({
            status: endpointConnectivityStatus,
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        }),
        useSyncError: () => syncErrorState,
    } as any);
});

vi.mock('@/auth/routing/authRouting', () => {
    return {
        isPublicRouteForUnauthenticated: () => false,
    };
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: activeServerId,
        serverUrl: 'https://example.com',
        generation: 1,
    }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
                    colors: {
                        surface: '#fff',
                        header: { background: '#fff', tint: '#000' },
                    },
                },
    });
});

vi.mock('@/utils/platform/platform', () => {
    return { isRunningOnMac: () => false };
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
    invokeTauri: (...args: any[]) => invokeTauriSpy(...args),
    listenTauriEvent: vi.fn(async () => () => {}),
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router.replace.mockReset();
    router.push.mockReset();
    invokeTauriSpy.mockReset();
    notificationNativeState.unavailable = false;
    lastNotificationResponse = null;
    platformState.os = 'web';
    tauriDesktopState.value = false;
    isAuthenticated = true;
    segments = ['(app)'];
    pathname = '/';
    endpointConnectivityStatus = 'online';
    syncErrorState = null;
    activeServerId = 'server-active';
    globalSearchParamsState = {};
    stackNavigatorScreenOptionsHistory = [];
});

describe('RootLayout hooks order', () => {
    it('does not throw when redirecting after a non-redirect render', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        isAuthenticated = true;
        segments = ['(app)'];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(RootLayout))).tree;

            isAuthenticated = false;
            segments = ['(app)', 'settings'];

            expect(() => {
                act(() => {
                    tree!.update(React.createElement(RootLayout));
                });
            }).not.toThrow();
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 60_000);

    it('renders a redirect instead of a blank tree for unauthenticated protected routes', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        isAuthenticated = false;
        segments = ['(app)', 'settings', 'account'];
        pathname = '/settings/account';

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;

            const redirect = screen.findByType('Redirect' as never);
            expect(redirect.props.href).toBe('/');
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 30_000);
});

describe('RootLayout stack options', () => {
    it('keeps root stack screen options stable across unchanged renders', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(RootLayout))).tree;
            const initialScreenOptions = stackNavigatorScreenOptionsHistory.at(-1);
            const initialTerminalConnectOptions = tree.root
                .findAllByType('StackScreen')
                .find((node) => node.props?.name === 'terminal/connect')
                ?.props?.options;

            act(() => {
                tree!.update(React.createElement(RootLayout));
            });

            expect(stackNavigatorScreenOptionsHistory.at(-1)).toBe(initialScreenOptions);
            const updatedTerminalConnectOptions = tree.root
                .findAllByType('StackScreen')
                .find((node) => node.props?.name === 'terminal/connect')
                ?.props?.options;
            expect(updatedTerminalConnectOptions).toBe(initialTerminalConnectOptions);
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 60_000);

    it('disables stack screen animations for main tab routes', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(RootLayout))).tree;
            const mainTabRouteNames = new Set(['index', 'inbox/index', 'friends/index', 'settings']);
            const mainTabScreens = tree.root
                .findAllByType('StackScreen')
                .filter((node) => mainTabRouteNames.has(node.props?.name));

            expect(mainTabScreens).toHaveLength(mainTabRouteNames.size);
            for (const screen of mainTabScreens) {
                expect(screen.props?.options).toMatchObject({ animation: 'none' });
            }
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 60_000);

    it('does not freeze the native or web root index route', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            platformState.os = 'ios';
            tree = (await renderScreen(React.createElement(RootLayout))).tree;
            const screens = tree.root.findAllByType('StackScreen');
            const indexRoute = screens.find((node) => node.props?.name === 'index');
            expect(indexRoute?.props?.options?.freezeOnBlur).not.toBe(true);
            const frozenRoutes = screens
                .filter((node) => node.props?.options?.freezeOnBlur === true)
                .map((node) => node.props?.name);
            expect(frozenRoutes).toEqual([]);

            act(() => {
                tree!.unmount();
            });
            tree = undefined;

            platformState.os = 'web';
            tree = (await renderScreen(React.createElement(RootLayout))).tree;
            const webIndexRoute = tree.root
                .findAllByType('StackScreen')
                .find((node) => node.props?.name === 'index');
            expect(webIndexRoute?.props?.options?.freezeOnBlur).not.toBe(true);
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 30_000);
});

describe('RootLayout notification routing', () => {
    it('does not fail app layout import when expo notifications are unavailable on native', async () => {
        platformState.os = 'ios';
        notificationNativeState.unavailable = true;

        await expect(import('@/app/(app)/_layout')).resolves.toHaveProperty('default');
    });

    it('ignores absolute URLs from notification payloads', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        isAuthenticated = true;
        platformState.os = 'ios';
        lastNotificationResponse = {
            actionIdentifier: 'default',
            notification: {
                request: { content: { data: { url: 'https://evil.example' } } },
            },
        };

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;
            await act(async () => {});
            expect(router.push).not.toHaveBeenCalled();
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 30_000);
});

describe('RootLayout restore navigation', () => {
    it('uses coherent headers for restore flows', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;
            if (!tree) throw new Error('Expected renderer');

            const screens = screen.findAllByType('StackScreen' as any);
            const restoreIndex = screens.find((s) => s.props?.name === 'restore/index');
            expect(restoreIndex?.props?.options?.headerShown).toBe(false);

            const showQr = screens.find((s) => s.props?.name === 'restore/show-qr');
            expect(showQr?.props?.options?.headerShown).toBe(false);

            const manual = screens.find((s) => s.props?.name === 'restore/manual');
            expect(manual?.props?.options?.headerShown).toBe(false);

            const lostAccess = screens.find((s) => s.props?.name === 'restore/lost-access');
            expect(lostAccess?.props?.options?.headerShown).toBe(false);

            const sessionTerminal = screens.find((s) => s.props?.name === 'session/[id]/terminal');
            expect(sessionTerminal?.props?.options?.headerShown).toBe(false);
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 30_000);
});

describe('RootLayout settings routes', () => {
    it('registers only the settings navigator in the parent stack and keeps nested settings children out of it', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(React.createElement(RootLayout));

        const screens = screen.findAllByType('StackScreen' as any);
        const names = screens
            .map((node) => node.props?.name)
            .filter((name): name is string => typeof name === 'string');

        expect(names).toContain('settings');
        expect(names).not.toContain('settings/index');
        expect(names).not.toContain('settings/account');
        expect(names).not.toContain('settings/machines');
        expect(names).not.toContain('settings/report-issue');
        expect(names).not.toContain('settings/session/permissions');
    }, 60_000);
});

describe('RootLayout activity surfaces', () => {
    it('mounts the iOS activity surfaces runtime in the main app shell', async () => {
        stubFeatureFetch();
        platformState.os = 'ios';

        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(React.createElement(RootLayout));
        await flushHookEffects();

        expect(screen.findAllByType('ActivitySurfacesRuntime')).toHaveLength(1);
    }, 60_000);
});

describe('RootLayout desktop window sizing', () => {
    it('expands the Tauri desktop window for authenticated users even off the home route', async () => {
        stubFeatureFetch();
        tauriDesktopState.value = true;
        isAuthenticated = true;
        segments = ['(app)', 'settings'];
        pathname = '/settings';

        const { default: RootLayout } = await import('@/app/(app)/_layout');
        await renderScreen(React.createElement(RootLayout));

        expect(invokeTauriSpy).toHaveBeenCalledWith('desktop_set_window_mode', { mode: 'main' });
    }, 60_000);

    it('keeps the standard Tauri desktop window mode for unauthenticated users at the app shell', async () => {
        stubFeatureFetch();
        tauriDesktopState.value = true;
        isAuthenticated = false;
        segments = ['(app)'];
        pathname = '/';

        const { default: RootLayout } = await import('@/app/(app)/_layout');
        await renderScreen(React.createElement(RootLayout));

        expect(invokeTauriSpy).toHaveBeenCalledWith('desktop_set_window_mode', { mode: 'main' });
    }, 60_000);
});

describe('RootLayout auth recovery route hold', () => {
    it('does not redirect an unauthenticated already-open base session route when auth recovery is active', async () => {
        stubFeatureFetch();
        isAuthenticated = false;
        segments = ['(app)', 'session', '[id]'];
        pathname = '/session/s1';
        globalSearchParamsState = { id: 's1', serverId: 'server-active' };
        endpointConnectivityStatus = 'auth_failed';

        const { default: RootLayout } = await import('@/app/(app)/_layout');
        await renderScreen(React.createElement(RootLayout));

        expect(router.replace).not.toHaveBeenCalledWith('/');
    }, 60_000);

    it('still redirects an unauthenticated base session route to home when no auth recovery signal is active', async () => {
        stubFeatureFetch();
        isAuthenticated = false;
        segments = ['(app)', 'session', '[id]'];
        pathname = '/session/s1';
        globalSearchParamsState = { id: 's1', serverId: 'server-active' };
        endpointConnectivityStatus = 'online';
        syncErrorState = null;

        const { default: RootLayout } = await import('@/app/(app)/_layout');
        const screen = await renderScreen(React.createElement(RootLayout));

        const redirect = screen.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/');
    }, 60_000);

    it('normalizes a nested stale-auth session route back to the base session route', async () => {
        stubFeatureFetch();
        isAuthenticated = false;
        segments = ['(app)', 'session', '[id]', 'details'];
        pathname = '/session/s1/details';
        globalSearchParamsState = { id: 's1', serverId: 'server-active' };
        endpointConnectivityStatus = 'auth_failed';

        const { default: RootLayout } = await import('@/app/(app)/_layout');
        await renderScreen(React.createElement(RootLayout));

        expect(router.replace).toHaveBeenCalledWith('/session/s1?serverId=server-active');
        expect(router.replace).not.toHaveBeenCalledWith('/');
    }, 60_000);
});
