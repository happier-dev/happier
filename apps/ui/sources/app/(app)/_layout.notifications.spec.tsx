import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from './_layout.testHelpers';

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

const reloadSpy = vi.fn(async () => {});
vi.mock('expo-updates', () => ({
    reloadAsync: reloadSpy,
}));

const pushSpy = vi.fn();
const setActiveServerIdSpy = vi.fn();
const upsertServerProfileSpy = vi.fn();
const clearPendingTerminalConnectSpy = vi.fn();
let activeServerUrl = 'https://api.happier.dev';
let pendingTerminalConnectValue: { publicKeyB64Url: string; serverUrl: string } | null = null;

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

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@/auth/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/utils/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/components/navigation/Header', () => ({
    createHeader: () => null,
}));

vi.mock('@/hooks/useFriendsAllowUsernameSupport', () => ({
    useFriendsAllowUsernameSupport: () => false,
}));

vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({ settings: { voiceProviderId: 'off' } }),
    },
    useProfile: () => ({ linkedProviders: [], username: 'u' }),
}));

vi.mock('@/sync/storageStore', () => ({
    storage: (selector: (state: { profile: { linkedProviders: []; username: string } }) => unknown) =>
        selector({ profile: { linkedProviders: [], username: 'u' } }),
}));

vi.mock('@/sync/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
    setActiveServerId: (...args: unknown[]) => setActiveServerIdSpy(...args),
    upsertServerProfile: (...args: unknown[]) => upsertServerProfileSpy(...args),
}));

vi.mock('@/sync/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectValue,
    clearPendingTerminalConnect: () => clearPendingTerminalConnectSpy(),
    setPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/sync/apiFeatures', () => ({
    getCachedServerFeatures: () => null,
    getServerFeatures: async () =>
        createRootLayoutFeaturesResponse({
            voice: { enabled: false, configured: false, provider: null },
        }),
}));

afterEach(() => {
    activeServerUrl = 'https://api.happier.dev';
    pendingTerminalConnectValue = null;
    pushSpy.mockClear();
    reloadSpy.mockClear();
    setActiveServerIdSpy.mockClear();
    upsertServerProfileSpy.mockReset();
    clearPendingTerminalConnectSpy.mockClear();
    vi.restoreAllMocks();
    vi.resetModules();
});

async function renderRootLayout() {
    const RootLayout = (await import('./_layout')).default;
    await act(async () => {
        renderer.create(React.createElement(RootLayout));
        await Promise.resolve();
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

        expect(pushSpy).toHaveBeenCalledWith('/terminal/index?key=abc123&server=https%3A%2F%2Fapi.happier.dev');
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('switches server and reloads when pending terminal connect targets another server', async () => {
        pendingTerminalConnectValue = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://company.example.test',
        };
        activeServerUrl = 'https://api.happier.dev';
        upsertServerProfileSpy.mockReturnValue({
            id: 'company',
            name: 'company',
            serverUrl: 'https://company.example.test',
            webappUrl: 'https://company.example.test',
        });

        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(null);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(pushSpy).not.toHaveBeenCalledWith(expect.stringContaining('/terminal/index'));
        expect(setActiveServerIdSpy).toHaveBeenCalled();
        expect(reloadSpy).toHaveBeenCalled();
    });

    it('navigates to the session when a notification contains sessionId', async () => {
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
            notification: {
                request: { content: { data: { sessionId: 's_123' } } },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(pushSpy).toHaveBeenCalledWith('/session/s_123');
    });

    it('does not push immediately when a notification includes serverUrl', async () => {
        upsertServerProfileSpy.mockReturnValue({
            id: 'company',
            name: 'company',
            serverUrl: 'https://company.example.test',
            webappUrl: 'https://company.example.test',
        });

        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
            notification: {
                request: { content: { data: { sessionId: 's_456', serverUrl: 'https://company.example.test' } } },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(pushSpy).not.toHaveBeenCalledWith('/session/s_456');
        expect(reloadSpy).toHaveBeenCalled();
    });
});
