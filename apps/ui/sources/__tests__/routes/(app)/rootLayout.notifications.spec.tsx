import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createRootLayoutFeaturesResponse,
    createStorageStoreMock,
    flushHookEffects,
    renderScreen,
} from '@/dev/testkit';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = await vi.hoisted(async () => {
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    return {
        activeServerUrl: 'https://api.happier.dev',
        applySettingsSpy: vi.fn(),
        clearPendingNotificationActionSpy: vi.fn(),
        clearPendingNotificationNavSpy: vi.fn(),
        clearPendingTerminalConnectSpy: vi.fn(),
        lastUnmount: null as null | (() => Promise<void>),
        mockSettings: {
            ...settingsDefaults,
            voice: {
                ...settingsDefaults.voice,
                providerId: 'off' as const,
            },
        },
        pendingNotificationActionValue: null as { serverUrl: string; sessionId: string; requestId: string; action: 'allow' | 'deny' } | null,
        pendingNotificationNavValue: null as { serverUrl: string; route: string } | null,
        pendingTerminalConnectValue: null as { publicKeyB64Url: string; serverUrl: string } | null,
        pushSpy: vi.fn(),
        serverProfilesValue: [] as { id: string; serverUrl: string }[],
        sessionAllowSpy: vi.fn((..._args: unknown[]) => Promise.resolve()),
        sessionDenySpy: vi.fn((..._args: unknown[]) => Promise.resolve()),
        setActiveServerAndSwitchSpy: vi.fn(async (_params: { serverId: string; scope: string; refreshAuth: unknown }) => true),
        upsertActivateAndSwitchServerSpy: vi.fn(async (_params: { serverUrl: string; source: string; scope: string; refreshAuth: unknown }) => true),
    };
});

vi.mock('expo-notifications', () => ({
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    getLastNotificationResponseAsync: vi.fn(),
    clearLastNotificationResponseAsync: vi.fn(async () => {}),
    addNotificationResponseReceivedListener: vi.fn(() => ({ remove: () => {} })),
    setBadgeCountAsync: vi.fn(async () => {}),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installRootLayoutRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/',
            segments: ['(app)'],
            router: {
                push: mockState.pushSpy,
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: createStorageStoreMock({ settings: mockState.mockSettings as any }),
                // This route only reads a small subset of the profile/local settings storage contract.
                useProfile: () => ({ linkedProviders: [], username: 'u' } as any),
                useAllSessions: () => [],
                useFriendRequests: () => [],
                useLocalSettings: () => ({ activityBadgesEnabled: false } as any),
                useSettings: () => mockState.mockSettings as any,
                useSetting: ((key: keyof typeof mockState.mockSettings) => mockState.mockSettings[key]) as any,
            },
        });
    },
});

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

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = createStorageStoreMock({
        profile: { linkedProviders: [], username: 'u' } as any,
    });
    return { storage, getStorage: () => storage };
});

vi.mock('@/sync/sync', () => ({
    sync: {
        applySettings: (...args: unknown[]) => mockState.applySettingsSpy(...args),
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => mockState.activeServerUrl,
    listServerProfiles: () => mockState.serverProfilesValue.map((p) => ({ ...p, name: p.id, createdAt: 0, updatedAt: 0, lastUsedAt: 0 })),
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: mockState.activeServerUrl,
        kind: 'custom',
        generation: 1,
    }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: mockState.upsertActivateAndSwitchServerSpy,
    setActiveServerAndSwitch: mockState.setActiveServerAndSwitchSpy,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => mockState.pendingTerminalConnectValue,
    clearPendingTerminalConnect: () => mockState.clearPendingTerminalConnectSpy(),
    setPendingTerminalConnect: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingNotificationNav', () => ({
    getPendingNotificationNav: () => mockState.pendingNotificationNavValue,
    setPendingNotificationNav: (next: { serverUrl: string; route: string }) => {
        mockState.pendingNotificationNavValue = next;
    },
    clearPendingNotificationNav: () => {
        mockState.clearPendingNotificationNavSpy();
        mockState.pendingNotificationNavValue = null;
    },
}));

vi.mock('@/sync/domains/pending/pendingNotificationAction', () => ({
    getPendingNotificationAction: () => mockState.pendingNotificationActionValue,
    setPendingNotificationAction: (next: { serverUrl: string; sessionId: string; requestId: string; action: 'allow' | 'deny' }) => {
        mockState.pendingNotificationActionValue = next;
    },
    clearPendingNotificationAction: () => {
        mockState.clearPendingNotificationActionSpy();
        mockState.pendingNotificationActionValue = null;
    },
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: (...args: unknown[]) => mockState.sessionAllowSpy(...args),
    sessionDeny: (...args: unknown[]) => mockState.sessionDenySpy(...args),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () =>
        createRootLayoutFeaturesResponse({
            features: { voice: { enabled: false, happierVoice: { enabled: false } } },
            capabilities: { voice: { configured: false, provider: null, requested: false, disabledByBuildPolicy: false } },
        }),
}));

afterEach(async () => {
    mockState.activeServerUrl = 'https://api.happier.dev';
    mockState.serverProfilesValue = [];
    mockState.pendingTerminalConnectValue = null;
    mockState.pendingNotificationNavValue = null;
    mockState.pendingNotificationActionValue = null;
    await mockState.lastUnmount?.();
    mockState.lastUnmount = null;
    mockState.pushSpy.mockClear();
    mockState.upsertActivateAndSwitchServerSpy.mockReset();
    mockState.setActiveServerAndSwitchSpy.mockReset();
    mockState.clearPendingTerminalConnectSpy.mockClear();
    mockState.clearPendingNotificationNavSpy.mockClear();
    mockState.clearPendingNotificationActionSpy.mockClear();
    mockState.sessionAllowSpy.mockClear();
    mockState.sessionDenySpy.mockClear();
    vi.restoreAllMocks();
    vi.resetModules();
});

async function renderRootLayout() {
    const RootLayout = (await import('@/app/(app)/_layout')).default;
    await mockState.lastUnmount?.();
    mockState.lastUnmount = (await renderScreen(React.createElement(RootLayout))).unmount;
    await flushHookEffects();
}

describe('App RootLayout notifications', () => {
    it('routes to pending terminal connect after authentication', async () => {
        mockState.pendingTerminalConnectValue = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://api.happier.dev',
        };

        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(null);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(mockState.pushSpy).toHaveBeenCalledWith('/terminal/connect#key=abc123&server=https%3A%2F%2Fapi.happier.dev');
        expect(mockState.upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
    });

    it('switches server and continues without reloading when pending terminal connect targets another server', async () => {
        mockState.pendingTerminalConnectValue = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://company.example.test',
        };
        mockState.activeServerUrl = 'https://api.happier.dev';
        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(null);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(mockState.upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://company.example.test',
            source: 'url',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(mockState.pushSpy).toHaveBeenCalledWith('/terminal/connect#key=abc123&server=https%3A%2F%2Fcompany.example.test');
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

        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_123');
    });

    it('dedupes notification responses across cold start and response listener', async () => {
        const Notifications = await import('expo-notifications');
        const response = {
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
        };
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(response as any);
        vi.spyOn(Notifications, 'clearLastNotificationResponseAsync').mockResolvedValue(undefined as any);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation((listener: any) => {
            listener(response);
            return { remove: () => {} };
        });

        await renderRootLayout();

        expect(mockState.pushSpy).toHaveBeenCalledTimes(1);
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_123');
        expect(Notifications.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
    });

    it('switches server and navigates when a notification includes serverUrl', async () => {
        mockState.serverProfilesValue = [
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

        expect(mockState.setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'server-2',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_456');
    });

    it('does not auto-switch to loopback serverUrl from notifications', async () => {
        mockState.serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        mockState.activeServerUrl = 'https://api.happier.dev';
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

        expect(mockState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(mockState.upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_789');
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

        expect(mockState.sessionAllowSpy).toHaveBeenCalledWith('s_allow', 'p_allow', undefined, undefined, 'approved');
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_allow');
    });

    it('switches to a saved inactive server and performs permission allow when notification action is pressed', async () => {
        mockState.serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
            { id: 'server-2', serverUrl: 'https://company.example.test' },
        ];
        mockState.activeServerUrl = 'https://api.happier.dev';
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

        expect(mockState.setActiveServerAndSwitchSpy).toHaveBeenCalledWith({
            serverId: 'server-2',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(mockState.sessionAllowSpy).toHaveBeenCalledWith('s_allow_2', 'p_allow_2', undefined, undefined, 'approved');
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_allow_2');
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

        expect(mockState.sessionAllowSpy).not.toHaveBeenCalled();
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_allow_3');
    });

    it('does not perform permission allow when notification action targets an unsaved server', async () => {
        mockState.serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        mockState.activeServerUrl = 'https://api.happier.dev';
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

        expect(mockState.sessionAllowSpy).not.toHaveBeenCalled();
        expect(mockState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(mockState.upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(mockState.pendingNotificationNavValue).toEqual({ serverUrl: 'https://unknown.example.test', route: '/session/s_allow_4' });
        expect(mockState.pushSpy).toHaveBeenCalledWith('/server?url=https%3A%2F%2Funknown.example.test&source=notification');
    });

    it('ignores unknown notification action identifiers (does not auto-add or navigate)', async () => {
        mockState.serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        mockState.activeServerUrl = 'https://api.happier.dev';
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

        expect(mockState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(mockState.upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(mockState.pendingNotificationNavValue).toBe(null);
        expect(mockState.pushSpy).not.toHaveBeenCalled();
    });

    it('auto-adds and switches server when zero servers exist and a permission action targets an unsaved server (but does not perform the action)', async () => {
        mockState.serverProfilesValue = [];
        mockState.activeServerUrl = 'https://api.happier.dev';
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

        expect(mockState.sessionAllowSpy).not.toHaveBeenCalled();
        expect(mockState.upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://new.example.test',
            source: 'notification',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_allow_5');
    });

    it('routes to server settings with a prefilled url when a notification targets an unsaved server and servers already exist', async () => {
        mockState.serverProfilesValue = [
            { id: 'server-1', serverUrl: 'https://api.happier.dev' },
        ];
        mockState.activeServerUrl = 'https://api.happier.dev';
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

        expect(mockState.pendingNotificationNavValue).toEqual({ serverUrl: 'https://unknown2.example.test', route: '/session/s_999' });
        expect(mockState.pushSpy).toHaveBeenCalledWith('/server?url=https%3A%2F%2Funknown2.example.test&source=notification');
        expect(mockState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(mockState.upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
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

        expect(mockState.sessionDenySpy).toHaveBeenCalledWith('s_deny', 'p_deny', undefined, undefined, 'denied', 'Denied from notification');
        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_deny');
    });
});
