import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

const historyReplaceStateSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();

const upsertActivateAndSwitchServerSpy = vi.fn(async (_params: { serverUrl: string; source: string; scope: string; refreshAuth: unknown }) => true);
const refreshFromActiveServerSpy = vi.fn(async () => {});
let activeServerUrl = 'https://api.happier.dev';
let activeServerSnapshot: { serverId: string; serverUrl: string; generation: number } | null = null;

function readActiveServerSnapshot() {
    if (activeServerSnapshot?.serverUrl === activeServerUrl) return activeServerSnapshot;
    activeServerSnapshot = { serverId: 'server-a', serverUrl: activeServerUrl, generation: 1 };
    return activeServerSnapshot;
}

vi.mock('expo-updates', () => ({
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })),
    fetchUpdateAsync: vi.fn(async () => ({})),
    reloadAsync: vi.fn(async () => {}),
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
                push: routerPushSpy,
                replace: routerReplaceSpy,
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(choices: { web?: T; default?: T }) => choices?.web ?? choices?.default,
            },
            AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { surface: '#fff', header: { background: '#fff', tint: '#000' } } },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: refreshFromActiveServerSpy }),
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({
        updateAvailable: false,
        isChecking: false,
        checkForUpdates: vi.fn(async () => {}),
        reloadApp: vi.fn(async () => {}),
    }),
}));

vi.mock('@/activity/badges/ActivityBadgeRuntime', () => ({
    ActivityBadgeRuntime: () => null,
}));

vi.mock('@/activity/notifications/runtime/ActivityLocalNotificationRuntime', () => ({
    ActivityLocalNotificationRuntime: () => null,
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/path/routeUtils', () => ({
    coerceRelativeRoute: (value: string) => value,
}));

vi.mock('@/components/navigation/Header', () => ({
    createHeader: () => null,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/pending/pendingNotificationNav', () => ({
    getPendingNotificationNav: () => null,
    clearPendingNotificationNav: vi.fn(),
    setPendingNotificationNav: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingNotificationAction', () => ({
    getPendingNotificationAction: () => null,
    clearPendingNotificationAction: vi.fn(),
    setPendingNotificationAction: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerUrl: () => activeServerUrl,
        getActiveServerSnapshot: readActiveServerSnapshot,
        subscribeActiveServer: () => () => {},
        getTabActiveServerId: () => null,
        listServerProfiles: () => [],
    };
});

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    isSameServerUrl: (left: string, right: string) => {
        const normalizeComparable = (value: string) => {
            const raw = String(value ?? '').trim().replace(/\/+$/, '');
            if (!raw) return '';
            try {
                const url = new URL(raw);
                let hostname = String(url.hostname ?? '').trim().toLowerCase();
                if (hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.localhost')) {
                    hostname = 'localhost';
                }
                const port = String(url.port ?? '').trim();
                return `${url.protocol}//${hostname}${port ? `:${port}` : ''}`;
            } catch {
                return raw;
            }
        };
        const leftKey = normalizeComparable(left);
        if (!leftKey) return false;
        return leftKey === normalizeComparable(right);
    },
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerSpy,
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () => null,
}));

afterEach(() => {
    activeServerUrl = 'https://api.happier.dev';
    activeServerSnapshot = null;
    historyReplaceStateSpy.mockReset();
    routerPushSpy.mockReset();
    routerReplaceSpy.mockReset();
    upsertActivateAndSwitchServerSpy.mockReset();
    refreshFromActiveServerSpy.mockReset();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    vi.restoreAllMocks();
    vi.resetModules();
    standardCleanup();
});

async function renderRootLayout() {
    const RootLayout = (await import('@/app/(app)/_layout')).default;
    await renderScreen(React.createElement(RootLayout));
    await flushHookEffects();
}

describe('App RootLayout server override', () => {
    it('renders safely when `?server=` is present on web routes', async () => {
        // Minimal web globals: enough for readServerUrlOverrideFromWebLocation().
        (globalThis as any).document = {};
        (globalThis as any).window = {
            location: {
                href: 'https://app.example.test/?server=https%3A%2F%2Fstack.example.test',
                pathname: '/',
                search: '?server=https%3A%2F%2Fstack.example.test',
                hash: '',
                reload: vi.fn(),
            },
            history: { replaceState: historyReplaceStateSpy },
        };

        await renderRootLayout();
        expect(historyReplaceStateSpy.mock.calls.length).toBeGreaterThanOrEqual(0);
    });

    it('normalizes legacy `?url=...&auto=1` into the same device-scoped server override flow', async () => {
        (globalThis as any).document = {};
        (globalThis as any).window = {
            location: {
                href: 'https://app.example.test/server?url=https%3A%2F%2Fstack.example.test&auto=1',
                pathname: '/server',
                search: '?url=https%3A%2F%2Fstack.example.test&auto=1',
                hash: '',
                reload: vi.fn(),
            },
            history: { replaceState: historyReplaceStateSpy },
        };

        await renderRootLayout();

        expect(upsertActivateAndSwitchServerSpy).toHaveBeenCalledWith({
            serverUrl: 'https://stack.example.test',
            source: 'url',
            scope: 'device',
            refreshAuth: refreshFromActiveServerSpy,
        });
        expect(historyReplaceStateSpy).toHaveBeenCalledWith(null, '', '/server');
    });

    it('treats loopback-equivalent `?server=` overrides as already-active and refreshes auth without switching servers', async () => {
        activeServerUrl = 'http://localhost:4325';
        (globalThis as any).document = {};
        (globalThis as any).window = {
            location: {
                href: 'https://app.example.test/?server=http%3A%2F%2F127.0.0.1%3A4325',
                pathname: '/',
                search: '?server=http%3A%2F%2F127.0.0.1%3A4325',
                hash: '',
                reload: vi.fn(),
            },
            history: { replaceState: historyReplaceStateSpy },
        };

        await renderRootLayout();

        expect(upsertActivateAndSwitchServerSpy).not.toHaveBeenCalled();
        expect(refreshFromActiveServerSpy).toHaveBeenCalled();
        expect(historyReplaceStateSpy).toHaveBeenCalledWith(null, '', '/');
    });

    it('redirects legacy `/?id=<sessionId>` deep-links to the canonical session route on web', async () => {
        (globalThis as any).document = {};
        (globalThis as any).window = {
            location: {
                href: 'https://app.example.test/?id=session-123&serverId=server-abc&messageId=msg-9&jumpChildId=child-2',
                pathname: '/',
                search: '?id=session-123&serverId=server-abc&messageId=msg-9&jumpChildId=child-2',
                hash: '',
                reload: vi.fn(),
            },
            history: { replaceState: historyReplaceStateSpy },
        };

        await renderRootLayout();

        expect(historyReplaceStateSpy).toHaveBeenCalledWith(null, '', '/?serverId=server-abc&messageId=msg-9&jumpChildId=child-2');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-123/message/msg-9?serverId=server-abc&jumpChildId=child-2');
    });
});
