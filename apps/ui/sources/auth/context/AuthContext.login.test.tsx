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
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getActiveServerId: () => activeServerSnapshotState.serverId,
    getActiveServerUrl: () => activeServerSnapshotState.serverUrl,
    listServerProfiles: () => [],
}));

function buildTokenWithSub(sub: string): string {
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64');
    return `hdr.${payload}.sig`;
}

describe('AuthContext.login', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
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

    it('replaces persisted and in-memory E2EE credentials with a token-only credential', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        const initialCredentials = {
            token,
            encryption: {
                publicKey: 'account-public-key',
                machineKey: 'account-machine-key',
            },
        };
        await TokenStorage.setCredentials(initialCredentials);
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials,
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await act(async () => {
                await expect(auth.loginWithCredentials({ token }))
                    .resolves.toEqual({ kind: 'completed' });
            });

            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.credentials).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(syncSwitchServerSpy).toHaveBeenCalledWith({ token });
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

    it('runs the authorized pre-mutation callback immediately before destructive logout', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const { trackLogout } = await import('@/track');
        const beforeMutation = vi.fn();
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            let result;
            await act(async () => {
                result = await auth.logout({
                    beforeMutation,
                });
            });
            expect(result).toEqual({
                kind: 'completed',
            });

            expect(beforeMutation).toHaveBeenCalledTimes(1);
            expect(trackLogout).toHaveBeenCalledTimes(1);
            expect(
                beforeMutation.mock.invocationCallOrder[0],
            ).toBeLessThan(
                vi.mocked(trackLogout).mock.invocationCallOrder[0]!,
            );
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
        } finally {
            await screen.unmount();
        }
    });

    it('blocks logout before any auth mutation while marked first-key custody is active', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            serverId: activeServerSnapshotState.serverId,
            serverUrl: activeServerSnapshotState.serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'account-test',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                migrationSubmissionAttempted: true,
            },
        })).resolves.toBe(true);
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toMatchObject({
            serverMismatch: false,
            value: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted: true,
                },
            },
        });
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const { trackLogout } = await import('@/track');
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            const logoutCallsBefore =
                vi.mocked(trackLogout).mock.calls.length;
            const beforeMutation = vi.fn();
            const result = await auth.logout({
                beforeMutation,
            });

            expect(result).toMatchObject({ kind: 'finish_encryption_setup' });
            expect(beforeMutation).not.toHaveBeenCalled();
            expect(vi.mocked(trackLogout).mock.calls.length)
                .toBe(logoutCallsBefore);
            expect(syncSwitchServerSpy).not.toHaveBeenCalledWith(null);
            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        } finally {
            await screen.unmount();
        }
    });

    it('does not mutate auth state when the authorized pre-mutation callback fails', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const { trackLogout } = await import('@/track');
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            const logoutCallsBefore =
                vi.mocked(trackLogout).mock.calls.length;

            await expect(auth.logout({
                beforeMutation: () => {
                    throw new Error('navigation failed');
                },
            })).rejects.toThrow('navigation failed');

            expect(vi.mocked(trackLogout).mock.calls.length)
                .toBe(logoutCallsBefore);
            expect(syncSwitchServerSpy).not.toHaveBeenCalledWith(null);
            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        } finally {
            await screen.unmount();
        }
    });

    it('awaits an authorized asynchronous pre-mutation callback before deleting local credentials', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const beforeMutation = vi.fn(async () => await pending);
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');
            const logout = auth.logout({ beforeMutation });
            await vi.waitFor(() => expect(beforeMutation).toHaveBeenCalledTimes(1));

            expect(await TokenStorage.getCredentials()).toEqual({ token });
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);

            await act(async () => {
                release();
                await logout;
            });
            expect(getCurrentAuth()?.isAuthenticated).toBe(false);
        } finally {
            await screen.unmount();
        }
    });

    it('blocks different-token replacement and unproven same-token keyed replacement', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const token = buildTokenWithSub('server-test');
        await TokenStorage.setCredentials({ token });
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            serverId: activeServerSnapshotState.serverId,
            serverUrl: activeServerSnapshotState.serverUrl,
            accountEncryptionFirstKey: {
                accountId: 'account-test',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                migrationSubmissionAttempted: true,
            },
        })).resolves.toBe(true);
        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toMatchObject({
            serverMismatch: false,
            value: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted: true,
                },
            },
        });
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected current auth to be set');

            await expect(auth.loginWithCredentials({ token: 'different-token' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            expect(await TokenStorage.getCredentials()).toEqual({ token });

            await expect(auth.loginWithCredentials({ token, secret: 'recovered-secret' }))
                .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
            expect(await TokenStorage.getCredentials()).toEqual({ token });
        } finally {
            await screen.unmount();
        }
    });
});
