import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


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

let isAuthenticated = true;
let allowPublicUnauthRoute = false;
let segments: string[] = ['(app)'];
let pathname = '/';

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

type StackScreenTestNode = Readonly<{
    props?: Readonly<{
        name?: string;
        options?: Record<string, unknown> | ((args: { navigation: { navigate: ReturnType<typeof vi.fn> } }) => Record<string, unknown>);
    }>;
}>;

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

// No local `react-native-reanimated` mock: `dev/vitestSetup.ts` already installs the canonical
// `createReanimatedModuleMock()` for every suite. An empty local mock overrode it and silently
// removed every export, so the first production module to read one at import time — the spring
// vocabulary's `ReduceMotion` — failed the whole file at collection rather than at an assertion.

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
    return { Typography: { default: () => ({}), eyebrow: () => ({}), header: () => ({}), keyHint: () => ({}), tabular: () => ({}) } };
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

vi.mock('@/activity/badges/ActivityBadgeRuntime', () => ({
    ActivityBadgeRuntime: () => null,
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
        segments: () => {
            React.useMemo(() => 0, [segments.join('|')]);
            return segments;
        },
    });
    return expoRouterMock.module;
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

vi.mock('@/auth/routing/authRouting', () => {
    return {
        isPublicRouteForUnauthenticated: () => allowPublicUnauthRoute,
    };
});

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

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router.replace.mockReset();
    router.push.mockReset();
    notificationNativeState.unavailable = false;
    lastNotificationResponse = null;
    platformState.os = 'web';
    isAuthenticated = true;
    allowPublicUnauthRoute = false;
    segments = ['(app)'];
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
    }, 60_000);
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

describe('RootLayout unauth navigation chrome', () => {
    it('hides native headers for unauthenticated shell routes', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        isAuthenticated = false;
        allowPublicUnauthRoute = true;
        segments = ['(app)', 'restore'];
        pathname = '/restore';

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;
            if (!tree) throw new Error('Expected renderer');

            const screens = screen.findAllByType('StackScreen' as any);
            for (const name of [
                'index',
                'setup',
                'restore/index',
                'restore/show-qr',
                'restore/manual',
                'restore/lost-access',
                'mtls',
                'oauth/[provider]',
                'terminal/connect',
                'terminal/index',
            ]) {
                const routeScreen = screens.find((s) => s.props?.name === name);
                expect(routeScreen?.props?.options?.headerShown).toBe(false);
            }

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

describe('RootLayout main tabs', () => {
    it('disables stack screen animations for main tab routes', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;
            if (!tree) throw new Error('Expected renderer');

            const screens = screen.findAllByType('StackScreen' as any);
            for (const name of ['index', 'inbox/index', 'friends/index', 'settings']) {
                const routeScreen = screens.find((s) => s.props?.name === name);
                expect(routeScreen?.props?.options).toEqual(expect.objectContaining({
                    animation: 'none',
                }));
            }
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 30_000);
});

describe('RootLayout session cockpit surface routes', () => {
    it('disables outer stack animations between cockpit surface routes', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;
            if (!tree) throw new Error('Expected renderer');

            const screens = screen.findAllByType('StackScreen' as any);
            for (const name of [
                'session/[id]/files',
                'session/[id]/git',
                'session/[id]/details',
                'session/[id]/terminal',
                'session/[id]/index',
            ]) {
                const routeScreen = screens.find((s) => s.props?.name === name);
                expect(routeScreen?.props?.options).toEqual(expect.objectContaining({
                    animation: 'none',
                }));
            }
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 30_000);
});

describe('RootLayout native freeze policy', () => {
    function resolveScreenOptions(screen: StackScreenTestNode): Record<string, unknown> {
        const options = screen.props?.options;
        if (typeof options === 'function') {
            return options({ navigation: { navigate: vi.fn() } });
        }
        return options ?? {};
    }

    it('does not freeze the native root index route or side-effect routes', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        platformState.os = 'ios';

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;
            if (!tree) throw new Error('Expected renderer');

            const screens = screen.findAllByType('StackScreen' as any) as StackScreenTestNode[];
            const indexRoute = screens.find((node) => node.props?.name === 'index');
            expect(indexRoute).toBeTruthy();
            expect(resolveScreenOptions(indexRoute!).freezeOnBlur).not.toBe(true);

            const explicitlyFrozenRoutes = screens
                .filter((node) => resolveScreenOptions(node).freezeOnBlur === true)
                .map((node) => node.props?.name);
            expect(explicitlyFrozenRoutes).toEqual([]);

            const newSessionRoute = screens.find((node) => node.props?.name === 'new/index');
            expect(newSessionRoute).toBeTruthy();
            const newSessionOptions = resolveScreenOptions(newSessionRoute!);
            // Default account settings leave `useEnhancedSessionWizard` false, so /new renders the
            // simple composer. It is presented as a NON-CONTAINED transparent modal — the only
            // presentation family for which native-stack omits its opaque `contentStyle` background,
            // and the one that keeps the screen on the same popover-measurement branch as the sheet
            // it replaces. The per-variant matrix is covered by `newSessionPresentation.test.ts`;
            // this asserts the layout actually wires the resolver's output through.
            expect(newSessionOptions.presentation).toBe('transparentModal');
            expect(newSessionOptions.sheetAllowedDetents).toBeUndefined();
            // The composer owns its own backdrop, entrance and close control, so the navigator must
            // contribute no chrome and no transition of its own.
            expect(newSessionOptions.headerShown).toBe(false);
            // No native transition: the screen owns both directions in Reanimated so the entrance
            // can be snappy and can actually slide. UIKit's modal cross-dissolve is the only
            // correctly-timed alternative and its duration is not settable.
            expect(newSessionOptions.animation).toBe('none');
            expect(newSessionOptions.contentStyle).toEqual({ backgroundColor: 'transparent' });

            for (const routeName of [
                'new/index',
                'direct/browse',
                'friends/manage',
                'oauth/[provider]',
                'mtls',
                'setup',
                'restore/index',
                'restore/show-qr',
                'restore/manual',
                'restore/lost-access',
                'scan/terminal',
                'scan/account',
                'terminal/connect',
                'terminal/index',
                'session/[id]/index',
            ]) {
                const routeScreen = screens.find((node) => node.props?.name === routeName);
                expect(routeScreen, `missing Stack.Screen for ${routeName}`).toBeTruthy();
                expect(resolveScreenOptions(routeScreen!).freezeOnBlur).not.toBe(true);
            }
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 60_000);

    it('does not rely on native freeze for the web root index route', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        platformState.os = 'web';

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const screen = await renderScreen(React.createElement(RootLayout));
            tree = screen.tree;
            if (!tree) throw new Error('Expected renderer');

            const screens = screen.findAllByType('StackScreen' as any) as StackScreenTestNode[];
            const indexRoute = screens.find((node) => node.props?.name === 'index');
            expect(indexRoute).toBeTruthy();
            expect(resolveScreenOptions(indexRoute!).freezeOnBlur).not.toBe(true);
        } finally {
            if (tree) {
                act(() => {
                    tree!.unmount();
                });
            }
        }
    }, 30_000);
});
