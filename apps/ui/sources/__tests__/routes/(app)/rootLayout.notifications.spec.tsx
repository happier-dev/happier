import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    createRootLayoutFeaturesResponse,
    createStorageStoreMock,
    flushHookEffects,
    renderScreen,
} from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = await vi.hoisted(async () => {
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    return {
        activeServerUrl: 'https://api.happier.dev',
        activeServerAccountScope: null as { serverId: string; accountId: string } | null,
        activeServerAccountScopeListeners: new Set<() => void>(),
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
        mockLocalSettings: {
            ...localSettingsDefaults,
            activityBadgesEnabled: false,
        } satisfies LocalSettings,
        pendingNotificationActionValue: null as { serverUrl: string; sessionId: string; requestId: string; action: 'allow' | 'deny' } | null,
        pendingNotificationNavValue: null as { serverUrl: string; route: string } | null,
        pendingTerminalConnectValue: null as { publicKeyB64Url: string; serverUrl: string } | null,
        pendingTerminalConnectRequiresScope: false,
        pushSpy: vi.fn(),
        navigateSpy: vi.fn(),
        serverProfilesValue: [] as { id: string; serverUrl: string }[],
        tabActiveServerId: null as string | null,
        setActiveServerAndSwitchSpy: vi.fn(async (_params: { serverId: string; scope: string; refreshAuth: unknown }) => true),
        upsertActivateAndSwitchServerSpy: vi.fn(async (_params: { serverUrl: string; source: string; scope: string; refreshAuth: unknown }) => true),
    };
});

const expoNotificationsMock = vi.hoisted(() => ({
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    getLastNotificationResponseAsync: vi.fn(),
    clearLastNotificationResponseAsync: vi.fn(async () => {}),
    addNotificationResponseReceivedListener: vi.fn(() => ({ remove: () => {} })),
    setBadgeCountAsync: vi.fn(async () => {}),
}));

vi.mock('expo-notifications', () => expoNotificationsMock);

vi.mock('@/utils/platform/loadExpoNotifications', () => ({
    loadExpoNotifications: () => Promise.resolve(expoNotificationsMock),
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
                navigate: mockState.navigateSpy,
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
                storage: createStorageStoreMock({
                    settings: mockState.mockSettings as any,
                    localSettings: mockState.mockLocalSettings,
                }),
                // This route only reads a small subset of the profile/local settings storage contract.
                useProfile: () => ({ linkedProviders: [], username: 'u' } as any),
                useAllSessions: () => [],
                useFriendRequests: () => [],
                useLocalSettings: () => mockState.mockLocalSettings,
                useLocalSetting: (<K extends keyof LocalSettings>(key: K): LocalSettings[K] =>
                    mockState.mockLocalSettings[key]) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
                useSettings: () => mockState.mockSettings as any,
                useSetting: ((key: keyof typeof mockState.mockSettings) => mockState.mockSettings[key]) as any,
                useActiveServerAccountScope: () => React.useSyncExternalStore(
                    (listener) => {
                        mockState.activeServerAccountScopeListeners.add(listener);
                        return () => mockState.activeServerAccountScopeListeners.delete(listener);
                    },
                    () => mockState.activeServerAccountScope,
                    () => mockState.activeServerAccountScope,
                ),
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

vi.mock('@/desktop/tray/DesktopTrayRuntime', () => ({
    DesktopTrayRuntime: () => null,
}));

vi.mock('@/hooks/server/useFriendsAllowUsernameSupport', () => ({
    useFriendsAllowUsernameSupport: () => false,
}));

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = createStorageStoreMock({
        profile: { linkedProviders: [], username: 'u' } as any,
        localSettings: mockState.mockLocalSettings,
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
    getTabActiveServerId: () => mockState.tabActiveServerId,
    listServerProfiles: () => mockState.serverProfilesValue.map((p) => ({ ...p, name: p.id, createdAt: 0, updatedAt: 0, lastUsedAt: 0 })),
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: mockState.activeServerUrl,
        kind: 'custom',
        generation: 1,
    }),
    resolveServerProfileScopeId: (profile: { id?: string; serverIdentityId?: string | null }) => profile.serverIdentityId || profile.id || '',
    resolveServerProfileScopeIdForIdentifier: (id: string | null | undefined) => String(id ?? '').trim(),
    areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => (
        String(left ?? '').trim() !== ''
        && String(left ?? '').trim() === String(right ?? '').trim()
    ),
    subscribeActiveServer: () => () => {},
    subscribeServerProfiles: () => () => {},
    setServerProfileIdentityForUrl: vi.fn(),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: mockState.upsertActivateAndSwitchServerSpy,
    setActiveServerAndSwitch: mockState.setActiveServerAndSwitchSpy,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => (
        mockState.pendingTerminalConnectRequiresScope && !mockState.activeServerAccountScope
            ? null
            : mockState.pendingTerminalConnectValue
    ),
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

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () =>
        createRootLayoutFeaturesResponse({
            features: { voice: { enabled: false, happierVoice: { enabled: false } } },
            capabilities: { voice: { configured: false, provider: null, requested: false, disabledByBuildPolicy: false } },
        }),
}));

afterEach(async () => {
    mockState.activeServerUrl = 'https://api.happier.dev';
    mockState.activeServerAccountScope = null;
    mockState.serverProfilesValue = [];
    mockState.tabActiveServerId = null;
    mockState.pendingTerminalConnectValue = null;
    mockState.pendingTerminalConnectRequiresScope = false;
    mockState.pendingNotificationNavValue = null;
    mockState.pendingNotificationActionValue = null;
    await mockState.lastUnmount?.();
    mockState.lastUnmount = null;
    mockState.pushSpy.mockClear();
    mockState.navigateSpy.mockClear();
    mockState.upsertActivateAndSwitchServerSpy.mockReset();
    mockState.setActiveServerAndSwitchSpy.mockReset();
    mockState.clearPendingTerminalConnectSpy.mockClear();
    mockState.clearPendingNotificationNavSpy.mockClear();
    mockState.clearPendingNotificationActionSpy.mockClear();
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

    it('resumes terminal connect exactly once when account scope hydrates after authentication', async () => {
        mockState.pendingTerminalConnectValue = {
            publicKeyB64Url: 'hydrated-key',
            serverUrl: 'https://api.happier.dev',
        };
        mockState.pendingTerminalConnectRequiresScope = true;

        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(null);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();
        expect(mockState.pushSpy).not.toHaveBeenCalled();

        await act(async () => {
            mockState.activeServerAccountScope = { serverId: 'server-1', accountId: 'account-a' };
            for (const listener of mockState.activeServerAccountScopeListeners) listener();
        });
        await flushHookEffects();
        await act(async () => {
            for (const listener of mockState.activeServerAccountScopeListeners) listener();
        });
        await flushHookEffects();

        expect(mockState.pushSpy).toHaveBeenCalledTimes(1);
        expect(mockState.pushSpy).toHaveBeenCalledWith('/terminal/connect#key=hydrated-key&server=https%3A%2F%2Fapi.happier.dev');
    });

    it('promotes pending terminal connect server when a tab override masks the device default', async () => {
        mockState.pendingTerminalConnectValue = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://api.happier.dev',
        };
        mockState.activeServerUrl = 'https://api.happier.dev';
        mockState.tabActiveServerId = 'api-server';

        const Notifications = await import('expo-notifications');
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValue(null);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation(() => ({ remove: () => {} }));

        await renderRootLayout();

        expect(mockState.upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://api.happier.dev',
            source: 'url',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(mockState.pushSpy).toHaveBeenCalledWith('/terminal/connect#key=abc123&server=https%3A%2F%2Fapi.happier.dev');
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

        expect(mockState.navigateSpy).toHaveBeenCalledWith('/session/s_123', expect.any(Object));
    });

    it('dedupes body taps within a mount and permits the same notification after remount', async () => {
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
        vi.spyOn(Notifications, 'getLastNotificationResponseAsync').mockResolvedValueOnce(response).mockResolvedValue(null);
        vi.spyOn(Notifications, 'clearLastNotificationResponseAsync').mockResolvedValue(undefined as any);
        vi.spyOn(Notifications, 'addNotificationResponseReceivedListener').mockImplementation((listener: any) => {
            listener(response);
            return { remove: () => {} };
        });

        await renderRootLayout();

        expect(mockState.navigateSpy).toHaveBeenCalledTimes(1);
        expect(mockState.navigateSpy).toHaveBeenCalledWith('/session/s_123', expect.any(Object));
        expect(Notifications.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1);

        // A new live body tap remains navigation after the root hook remounts.
        await renderRootLayout();
        expect(mockState.navigateSpy).toHaveBeenCalledTimes(2);
        expect(mockState.navigateSpy).toHaveBeenLastCalledWith('/session/s_123', expect.any(Object));
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
        expect(mockState.navigateSpy).toHaveBeenCalledWith('/session/s_456?serverId=server-2', expect.any(Object));
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

    it('opens the session for review from an older permission notification', async () => {
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

        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_allow');
    });

    it('switches to the saved server and opens review for an older permission notification', async () => {
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
        expect(mockState.navigateSpy).toHaveBeenCalledWith('/session/s_allow_2?serverId=server-2', expect.any(Object));
        expect(mockState.navigateSpy.mock.calls[0]?.[1]?.dangerouslySingular?.()).toBe('session');
    });

    it('opens the session when a permission notification has no serverUrl', async () => {
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

        expect(mockState.navigateSpy).toHaveBeenCalledWith('/session/s_allow_3', expect.any(Object));
    });

    it('opens server settings when a permission notification targets an unsaved server', async () => {
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

        expect(mockState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(mockState.upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(mockState.pendingNotificationNavValue).toEqual({ serverUrl: 'https://unknown.example.test', route: '/session/s_allow_4' });
        expect(mockState.pushSpy).toHaveBeenCalledWith('/settings/server?url=https%3A%2F%2Funknown.example.test&source=notification');
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

    it('auto-adds and switches server to open a permission notification when zero servers exist', async () => {
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

        expect(mockState.upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://new.example.test',
            source: 'notification',
            scope: 'device',
            refreshAuth: expect.any(Function),
        });
        expect(mockState.navigateSpy).toHaveBeenCalledWith('/session/s_allow_5', expect.any(Object));
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
        expect(mockState.pushSpy).toHaveBeenCalledWith('/settings/server?url=https%3A%2F%2Funknown2.example.test&source=notification');
        expect(mockState.setActiveServerAndSwitchSpy).not.toHaveBeenCalled();
        expect(mockState.upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
    });

    it('opens the session for review from an older deny notification', async () => {
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

        expect(mockState.pushSpy).toHaveBeenCalledWith('/session/s_deny');
    });
});
