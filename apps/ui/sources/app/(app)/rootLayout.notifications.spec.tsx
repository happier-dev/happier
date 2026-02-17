import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-notifications', () => ({
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    getLastNotificationResponseAsync: vi.fn(),
    addNotificationResponseReceivedListener: vi.fn(() => ({ remove: () => {} })),
}));

const pushSpy = vi.fn();
const upsertActivateAndSwitchServerSpy = vi.fn(async (_params: { serverUrl: string; source: string; scope: string; refreshAuth: unknown }) => true);
const applySettingsSpy = vi.fn();
const clearPendingTerminalConnectSpy = vi.fn();
const clearPendingNotificationNavSpy = vi.fn();
let activeServerUrl = 'https://api.happier.dev';
let pendingTerminalConnectValue: { publicKeyB64Url: string; serverUrl: string } | null = null;
let pendingNotificationNavValue: { serverUrl: string; route: string } | null = null;
let lastRenderer: renderer.ReactTestRenderer | null = null;

vi.mock('expo-router', () => ({
    Stack: Object.assign(
        ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
        { Screen: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children) }
    ),
    router: { push: pushSpy, replace: vi.fn() },
    useSegments: () => ['(app)'],
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Platform: {
            OS: 'ios',
            select: <T,>(choices: { ios?: T; default?: T }) => choices?.ios ?? choices?.default,
        },
        AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
    useUnistyles: () => ({ theme: { colors: { surface: '#fff', header: { background: '#fff', tint: '#000' } } } }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/components/navigation/Header', () => ({
    createHeader: () => null,
}));

vi.mock('@/hooks/server/useFriendsAllowUsernameSupport', () => ({
    useFriendsAllowUsernameSupport: () => false,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({ settings: { voice: { providerId: 'off' } } }),
    },
    useProfile: () => ({ linkedProviders: [], username: 'u' }),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: (selector: (state: { profile: { linkedProviders: []; username: string } }) => unknown) =>
        selector({ profile: { linkedProviders: [], username: 'u' } }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: (...args: unknown[]) => applySettingsSpy(...args),
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: activeServerUrl,
        kind: 'custom',
        generation: 1,
    }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerSpy,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectValue,
    clearPendingTerminalConnect: () => clearPendingTerminalConnectSpy(),
    setPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingNotificationNav', () => ({
    getPendingNotificationNav: () => pendingNotificationNavValue,
    setPendingNotificationNav: (next: { serverUrl: string; route: string }) => {
        pendingNotificationNavValue = next;
    },
    clearPendingNotificationNav: () => {
        clearPendingNotificationNavSpy();
        pendingNotificationNavValue = null;
    },
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () =>
        createRootLayoutFeaturesResponse({
            features: { voice: { enabled: false, happierVoice: { enabled: false } } },
            capabilities: { voice: { configured: false, provider: null, requested: false, disabledByBuildPolicy: false } },
        }),
}));

afterEach(() => {
    activeServerUrl = 'https://api.happier.dev';
    pendingTerminalConnectValue = null;
    pendingNotificationNavValue = null;
    try {
        act(() => {
            lastRenderer?.unmount();
        });
    } catch {
        // ignore
    }
    lastRenderer = null;
    pushSpy.mockClear();
    upsertActivateAndSwitchServerSpy.mockReset();
    clearPendingTerminalConnectSpy.mockClear();
    clearPendingNotificationNavSpy.mockClear();
    vi.restoreAllMocks();
    vi.resetModules();
});

async function renderRootLayout() {
    const RootLayout = (await import('./_layout')).default;
    await act(async () => {
        try {
            lastRenderer?.unmount();
        } catch {
            // ignore
        }
        lastRenderer = renderer.create(React.createElement(RootLayout));
        await Promise.resolve();
    });
    // RootLayout triggers async feature/capability probes that may schedule state updates after mount.
    // Flush one more turn to keep React act warnings out of test output.
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('App RootLayout notifications', () => {
    it('routes to pending terminal connect after authentication', async () => {
        pendingTerminalConnectValue = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://api.happier.dev',
        };

        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(null);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(pushSpy).toHaveBeenCalledWith('/terminal?key=abc123&server=https%3A%2F%2Fapi.happier.dev');
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
    });

    it('switches server and continues without reloading when pending terminal connect targets another server', async () => {
        pendingTerminalConnectValue = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://company.example.test',
        };
        activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(null);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://company.example.test',
            source: 'url',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(pushSpy).toHaveBeenCalledWith('/terminal?key=abc123&server=https%3A%2F%2Fcompany.example.test');
    });

    it('navigates to the session when a notification contains sessionId', async () => {
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n1',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_123' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(pushSpy).toHaveBeenCalledWith('/session/s_123');
    });

    it('switches server and navigates when a notification includes serverUrl', async () => {
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n2',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_456', serverUrl: 'https://company.example.test' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://company.example.test',
            source: 'notification',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(pushSpy).toHaveBeenCalledWith('/session/s_456');
    });
});
