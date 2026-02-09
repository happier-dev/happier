import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

let isAuthenticated = true;
let segments: string[] = ['(app)'];
let platformOs: 'web' | 'ios' = 'web';

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

vi.mock('expo-notifications', () => {
    return {
        DEFAULT_ACTION_IDENTIFIER: 'default',
        getLastNotificationResponseAsync: vi.fn(async () => lastNotificationResponse),
        addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
    };
});

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    type NativeChildrenProps = React.PropsWithChildren<Record<string, unknown>>;
    return {
        Ionicons: (props: NativeChildrenProps) => React.createElement('Ionicons', props, props.children),
    };
});

vi.mock('@/components/navigation/Header', () => {
    return { createHeader: () => null };
});

vi.mock('@/constants/Typography', () => {
    return { Typography: { default: () => ({}) } };
});

vi.mock('@/text', () => {
    return { t: (key: string) => key };
});

vi.mock('react-native', () => {
    const React = require('react');
    type NativeChildrenProps = React.PropsWithChildren<Record<string, unknown>>;
    type PlatformSelectOptions<T> = { web?: T; ios?: T; default?: T };
    return {
        View: (props: NativeChildrenProps) => React.createElement('View', props, props.children),
        ScrollView: (props: NativeChildrenProps) => React.createElement('ScrollView', props, props.children),
        Pressable: (props: NativeChildrenProps) => React.createElement('Pressable', props, props.children),
        TextInput: (props: NativeChildrenProps) => React.createElement('TextInput', props, props.children),
        ActivityIndicator: (props: NativeChildrenProps) => React.createElement('ActivityIndicator', props, props.children),
        Platform: {
            get OS() {
                return platformOs;
            },
            select: <T,>(options: PlatformSelectOptions<T>) => (platformOs === 'web' ? options.web ?? options.default : options.ios ?? options.default),
        },
        Dimensions: { get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }) },
        InteractionManager: { runAfterInteractions: (fn: () => void) => fn() },
        StyleSheet: { create: <T,>(styles: T) => styles },
        useWindowDimensions: () => ({ width: 800, height: 600 }),
        processColor: <T,>(value: T) => value,
        AppState: { addEventListener: () => ({ remove: () => {} }) },
        TouchableOpacity: (props: NativeChildrenProps) => React.createElement('TouchableOpacity', props, props.children),
        Text: (props: NativeChildrenProps) => React.createElement('Text', props, props.children),
    };
});

vi.mock('expo-router', () => {
    const React = require('react');
    type NativeChildrenProps = React.PropsWithChildren<Record<string, unknown>>;
    const Stack = (props: NativeChildrenProps) => React.createElement('Stack', props, props.children);
    Stack.Screen = (props: NativeChildrenProps) => React.createElement('StackScreen', props, props.children);
    return {
        Stack,
        router,
        useSegments: () => {
            React.useMemo(() => 0, [segments.join('|')]);
            return segments;
        },
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

vi.mock('@/auth/routing/authRouting', () => {
    return {
        isPublicRouteForUnauthenticated: () => false,
    };
});

vi.mock('react-native-unistyles', () => {
    const React = require('react');
    return {
        StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
        useUnistyles: () => {
            React.useMemo(() => 0, []);
            return {
                theme: {
                    colors: {
                        surface: '#fff',
                        header: { background: '#fff', tint: '#000' },
                    },
                },
            };
        },
    };
});

vi.mock('@/utils/platform/platform', () => {
    return { isRunningOnMac: () => false };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router.replace.mockReset();
    router.push.mockReset();
    lastNotificationResponse = null;
    platformOs = 'web';
    isAuthenticated = true;
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
            act(() => {
                tree = renderer.create(React.createElement(RootLayout));
            });

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
    }, 30_000);
});

describe('RootLayout notification routing', () => {
    it('ignores absolute URLs from notification payloads', async () => {
        stubFeatureFetch();

        const { default: RootLayout } = await import('@/app/(app)/_layout');

        isAuthenticated = true;
        platformOs = 'ios';
        lastNotificationResponse = {
            actionIdentifier: 'default',
            notification: {
                request: { content: { data: { url: 'https://evil.example' } } },
            },
        };

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            await act(async () => {
                tree = renderer.create(React.createElement(RootLayout));
            });
            await act(async () => {
                // flush microtasks
                await Promise.resolve();
            });
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
