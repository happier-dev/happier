import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const secureStore = vi.hoisted(() => new Map<string, string>());
const syncSwitchServerSpy = vi.hoisted(() =>
    vi.fn((credentials: { token: string; secret: string } | null) => {
        if (!credentials) return Promise.resolve();
        return new Promise<void>(() => {});
    }),
);
const switchConnectionToActiveServerSpy = vi.hoisted(() => vi.fn(async () => null));
const activeServerSnapshotState = vi.hoisted(() => ({
    serverId: '',
    serverUrl: '',
    generation: 0,
}));
const nextServerSequenceState = vi.hoisted(() => ({ value: 0 }));
let activeServerListener: ((snapshot: { serverId: string; serverUrl: string; generation: number }) => void) | null = null;
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
        secureStore.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
        secureStore.delete(key);
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

vi.mock('@/track', () => ({
    trackLogout: vi.fn(),
    initializeTracking: vi.fn(),
    tracking: null,
}));

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: syncSwitchServerSpy,
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ ...activeServerSnapshotState }),
    upsertAndActivateServer: ({ serverUrl }: { serverUrl: string }) => {
        nextServerSequenceState.value += 1;
        activeServerSnapshotState.serverId = `server-${nextServerSequenceState.value}`;
        activeServerSnapshotState.serverUrl = serverUrl;
        activeServerSnapshotState.generation += 1;
        return {
            id: activeServerSnapshotState.serverId,
            serverUrl,
        };
    },
    subscribeActiveServer: (listener: unknown) => {
        activeServerListener = listener as (snapshot: { serverId: string; serverUrl: string; generation: number }) => void;
        return () => {
            if (activeServerListener === listener) {
                activeServerListener = null;
            }
        };
    },
}));

function buildTokenWithSub(sub: string): string {
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64');
    return `hdr.${payload}.sig`;
}

describe('AuthContext.login', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        secureStore.clear();
        activeServerListener = null;
        activeServerSnapshotState.serverId = '';
        activeServerSnapshotState.serverUrl = '';
        activeServerSnapshotState.generation = 0;
        nextServerSequenceState.value = 0;
        syncSwitchServerSpy.mockClear();
        switchConnectionToActiveServerSpy.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('resolves without waiting for syncSwitchServer to finish', async () => {
        // Make sync's initial HTTP work hang so `syncSwitchServer` cannot complete until timers advance.
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');

        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: null,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await act(async () => {
                await auth.login(buildTokenWithSub('server-test'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            });
            await vi.advanceTimersByTimeAsync(1);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the session authenticated while a login-triggered server refresh is still rebinding credentials', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');

        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: null,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            await vi.waitFor(() => {
                expect(activeServerListener).toBeTypeOf('function');
            });

            const loginPromise = act(async () => {
                await auth.login(buildTokenWithSub('server-test'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            });
            await loginPromise;

            expect(getCurrentAuth()?.isAuthenticated).toBe(true);

            await act(async () => {
                activeServerListener?.({
                    serverId: 'server-test',
                    serverUrl: 'http://localhost:53288',
                    generation: 1,
                });
            });

            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        } finally {
            await screen.unmount();
        }
    });

    it('clears stale auth state when the active server changes during a login-triggered rebind', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });

        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');

        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: null,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            await vi.waitFor(() => {
                expect(activeServerListener).toBeTypeOf('function');
            });

            await act(async () => {
                await auth.login(buildTokenWithSub('server-test'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            });

            expect(getCurrentAuth()?.isAuthenticated).toBe(true);

            upsertAndActivateServer({ serverUrl: 'http://localhost:59876', scope: 'tab' });
            await act(async () => {
                await auth.refreshFromActiveServer();
            });

            expect(syncSwitchServerSpy).toHaveBeenCalledWith(null);
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
            expect(getCurrentAuth()?.credentials).toBeNull();
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the mobile brand hero dismissed after logout', async () => {
        const seenAt = 1_789_222_000_000;
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        const { clearPersistence, loadLocalSettings, saveLocalSettings } = await import('@/sync/domains/state/persistence');
        clearPersistence();
        saveLocalSettings({
            ...localSettingsDefaults,
            brandHeroSeenAt: seenAt,
        });

        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');

        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token: buildTokenWithSub('server-test'), secret: 'secret-test' },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await act(async () => {
                await auth.logout();
            });

            expect(loadLocalSettings().brandHeroSeenAt).toBe(seenAt);
        } finally {
            await screen.unmount();
            clearPersistence();
        }
    });
});
