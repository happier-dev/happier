import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit/rootLayoutTestkit';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';

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
const setActiveServerAndSwitchSpy = vi.fn(async (_params: { serverId: string; scope: string; refreshAuth: unknown }) => true);
const applySettingsSpy = vi.fn();
const sessionAllowSpy = vi.fn((..._args: unknown[]) => Promise.resolve());
const sessionDenySpy = vi.fn((..._args: unknown[]) => Promise.resolve());
const clearPendingTerminalConnectSpy = vi.fn();
const clearPendingNotificationNavSpy = vi.fn();
const clearPendingNotificationActionSpy = vi.fn();
let activeServerUrl = 'https://api.happier.dev';
let serverProfilesValue: { id: string; serverUrl: string }[] = [];
let pendingTerminalConnectValue: { publicKeyB64Url: string; serverUrl: string } | null = null;
let pendingNotificationNavValue: { serverUrl: string; route: string } | null = null;
let pendingNotificationActionValue: { serverUrl: string; sessionId: string; requestId: string; action: 'allow' | 'deny' } | null = null;
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

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = (selector: (state: { profile: { linkedProviders: []; username: string } }) => unknown) =>
        selector({ profile: { linkedProviders: [], username: 'u' } });
    return { storage, getStorage: () => storage };
});

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: (...args: unknown[]) => applySettingsSpy(...args),
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
    listServerProfiles: () => serverProfilesValue.map((p) => ({ ...p, name: p.id, createdAt: 0, updatedAt: 0, lastUsedAt: 0 })),
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
    setActiveServerAndSwitch: setActiveServerAndSwitchSpy,
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

vi.mock('@/sync/domains/pending/pendingNotificationAction', () => ({
    getPendingNotificationAction: () => pendingNotificationActionValue,
    setPendingNotificationAction: (next: { serverUrl: string; sessionId: string; requestId: string; action: 'allow' | 'deny' }) => {
        pendingNotificationActionValue = next;
    },
    clearPendingNotificationAction: () => {
        clearPendingNotificationActionSpy();
        pendingNotificationActionValue = null;
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: (...args: unknown[]) => sessionAllowSpy(...args),
    sessionDeny: (...args: unknown[]) => sessionDenySpy(...args),
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
    serverProfilesValue = [];
    pendingTerminalConnectValue = null;
    pendingNotificationNavValue = null;
    pendingNotificationActionValue = null;
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
    setActiveServerAndSwitchSpy.mockReset();
    clearPendingTerminalConnectSpy.mockClear();
    clearPendingNotificationNavSpy.mockClear();
    clearPendingNotificationActionSpy.mockClear();
    sessionAllowSpy.mockClear();
    sessionDenySpy.mockClear();
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
        serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
            { id: 'server-2', serverUrl: 'https://company.example.test' },
        ];
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

        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'server-2',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(pushSpy).toHaveBeenCalledWith('/session/s_456');
    });

    it('does not auto-switch to loopback serverUrl from notifications', async () => {
        serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n3',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_789', serverUrl: 'http://localhost:3005' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(pushSpy).toHaveBeenCalledWith('/session/s_789');
    });

    it('sends a permission allow response and navigates when notification action is pressed', async () => {
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n4',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_allow', requestId: 'p_allow', serverUrl: 'https://api.happier.dev' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(sessionAllowSpy).toHaveBeenCalledWith('s_allow', 'p_allow', undefined, undefined, 'approved');
        expect(pushSpy).toHaveBeenCalledWith('/session/s_allow');
    });

    it('switches to a saved inactive server and performs permission allow when notification action is pressed', async () => {
        serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
            { id: 'server-2', serverUrl: 'https://company.example.test' },
        ];
        activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n4b',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_allow_2', requestId: 'p_allow_2', serverUrl: 'https://company.example.test' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'server-2',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(sessionAllowSpy).toHaveBeenCalledWith('s_allow_2', 'p_allow_2', undefined, undefined, 'approved');
        expect(pushSpy).toHaveBeenCalledWith('/session/s_allow_2');
    });

    it('does not perform permission allow when notification action is pressed without serverUrl', async () => {
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n4c',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_allow_3', requestId: 'p_allow_3' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(sessionAllowSpy).not.toHaveBeenCalled();
        expect(pushSpy).toHaveBeenCalledWith('/session/s_allow_3');
    });

    it('does not perform permission allow when notification action targets an unsaved server', async () => {
        serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n4d',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_allow_4', requestId: 'p_allow_4', serverUrl: 'https://unknown.example.test' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(sessionAllowSpy).not.toHaveBeenCalled();
        expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(pendingNotificationNavValue).toEqual({ serverUrl: 'https://unknown.example.test', route: '/session/s_allow_4' });
        expect(pushSpy).toHaveBeenCalledWith('/server?url=https%3A%2F%2Funknown.example.test&source=notification');
    });

    it('ignores unknown notification action identifiers (does not auto-add or navigate)', async () => {
        serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: 'UNKNOWN_ACTION',
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n_unknown',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_unknown', serverUrl: 'https://unknown.example.test' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(pendingNotificationNavValue).toBe(null);
        expect(pushSpy).not.toHaveBeenCalled();
    });

    it('auto-adds and switches server when zero servers exist and a permission action targets an unsaved server (but does not perform the action)', async () => {
        serverProfilesValue = [];
        activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n4e',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_allow_5', requestId: 'p_allow_5', serverUrl: 'https://new.example.test' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(sessionAllowSpy).not.toHaveBeenCalled();
        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://new.example.test',
            source: 'notification',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(pushSpy).toHaveBeenCalledWith('/session/s_allow_5');
    });

    it('routes to server settings with a prefilled url when a notification targets an unsaved server and servers already exist', async () => {
        serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n6',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_999', serverUrl: 'https://unknown2.example.test' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(pendingNotificationNavValue).toEqual({ serverUrl: 'https://unknown2.example.test', route: '/session/s_999' });
        expect(pushSpy).toHaveBeenCalledWith('/server?url=https%3A%2F%2Funknown2.example.test&source=notification');
        expect(setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
    });

    it('sends a permission deny response and navigates when notification action is pressed', async () => {
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1,
            notification: {
                date: Date.parse('2026-02-09T00:00:00.000Z'),
                request: {
                    identifier: 'n5',
                    trigger: null,
                    content: {
                        title: null,
                        subtitle: null,
                        body: null,
                        categoryIdentifier: null,
                        sound: null,
                        data: { sessionId: 's_deny', requestId: 'p_deny', serverUrl: 'https://api.happier.dev' },
                    },
                },
            },
        });
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(sessionDenySpy).toHaveBeenCalledWith('s_deny', 'p_deny', undefined, undefined, 'denied', 'Denied from notification');
        expect(pushSpy).toHaveBeenCalledWith('/session/s_deny');
    });
});
