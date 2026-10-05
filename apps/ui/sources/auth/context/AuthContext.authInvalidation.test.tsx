import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const switchConnectionToActiveServerSpy = vi.hoisted(() => vi.fn(async () => null));
const disconnectActiveServerConnectionSpy = vi.hoisted(() => vi.fn(async () => {}));
const disconnectActiveServerConnectionIfCurrentSpy = vi.hoisted(() => vi.fn(async () => true));
const syncSwitchServerSpy = vi.hoisted(() => vi.fn(async () => {}));
const subscribeActiveServerSpy = vi.hoisted(() => vi.fn());
const subscribeAuthCredentialsInvalidationSpy = vi.hoisted(() => vi.fn());
const startConcurrentSessionCacheSyncSpy = vi.hoisted(() => vi.fn());
const stopConcurrentSessionCacheSyncSpy = vi.hoisted(() => vi.fn());

let authInvalidationListener: ((event: unknown) => void | Promise<void>) | null = null;

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
    disconnectActiveServerConnection: disconnectActiveServerConnectionSpy,
    disconnectActiveServerConnectionIfCurrent: disconnectActiveServerConnectionIfCurrentSpy,
}));

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: syncSwitchServerSpy,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'http://localhost:3012',
        generation: 1,
    }),
    subscribeActiveServer: (listener: unknown) => {
        subscribeActiveServerSpy(listener);
        return () => {};
    },
}));

vi.mock('@/sync/runtime/orchestration/authCredentialsInvalidation', () => ({
    subscribeAuthCredentialsInvalidation: (listener: unknown) => {
        subscribeAuthCredentialsInvalidationSpy(listener);
        authInvalidationListener = listener as ((event: unknown) => void | Promise<void>);
        return () => {
            if (authInvalidationListener === listener) {
                authInvalidationListener = null;
            }
        };
    },
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    clearPersistence: vi.fn(),
}));

vi.mock('@/track', () => ({
    trackLogout: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/concurrentSessionCache', () => ({
    startConcurrentSessionCacheSync: startConcurrentSessionCacheSyncSpy,
    stopConcurrentSessionCacheSync: stopConcurrentSessionCacheSyncSpy,
}));

describe('AuthContext credential invalidation handling', () => {
    beforeEach(() => {
        switchConnectionToActiveServerSpy.mockReset();
        switchConnectionToActiveServerSpy.mockResolvedValue(null);
        disconnectActiveServerConnectionSpy.mockReset();
        disconnectActiveServerConnectionIfCurrentSpy.mockReset();
        disconnectActiveServerConnectionIfCurrentSpy.mockResolvedValue(true);
        syncSwitchServerSpy.mockReset();
        subscribeActiveServerSpy.mockReset();
        subscribeAuthCredentialsInvalidationSpy.mockReset();
        startConcurrentSessionCacheSyncSpy.mockReset();
        stopConcurrentSessionCacheSyncSpy.mockReset();
        authInvalidationListener = null;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('disconnects first-key rejected auth through the connection owner without stopping secondary-server continuity', async () => {
        const { AuthProvider, ConcurrentSessionCacheRuntime, getCurrentAuth } = await import('./AuthContext');

        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token: 'token-a', secret: 'secret-a' },
                children: React.createElement(ConcurrentSessionCacheRuntime, null, React.createElement(React.Fragment)),
            }),
        );

        try {
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(startConcurrentSessionCacheSyncSpy).toHaveBeenCalledTimes(1);
            expect(subscribeAuthCredentialsInvalidationSpy).toHaveBeenCalledTimes(1);
            expect(authInvalidationListener).toBeTypeOf('function');

            await act(async () => {
                await authInvalidationListener?.({
                    kind: 'first_key_recovery_required',
                    serverId: 'server-a',
                    serverUrl: 'http://localhost:3012',
                    generation: 1,
                    recovery: {},
                });
            });

            await vi.waitFor(() => {
                expect(disconnectActiveServerConnectionIfCurrentSpy).toHaveBeenCalledWith({
                    serverId: 'server-a',
                    serverUrl: 'http://localhost:3012',
                    generation: 1,
                });
                expect(getCurrentAuth()?.isAuthenticated).toBe(false);
            });
            expect(switchConnectionToActiveServerSpy).not.toHaveBeenCalled();
            expect(syncSwitchServerSpy).not.toHaveBeenCalled();
            expect(stopConcurrentSessionCacheSyncSpy).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
        expect(stopConcurrentSessionCacheSyncSpy).toHaveBeenCalledTimes(1);
    });

    it('does not clear the focused Home when a delayed first-key invalidation belongs to another Home', async () => {
        disconnectActiveServerConnectionIfCurrentSpy.mockResolvedValue(false);
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
        const initialCredentials = { token: 'token-b', secret: 'secret-b' };
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials,
            children: React.createElement(React.Fragment, null),
        }));

        try {
            await act(async () => {
                await authInvalidationListener?.({
                    kind: 'first_key_recovery_required',
                    serverId: 'server-a',
                    serverUrl: 'http://localhost:3012',
                    generation: 1,
                    recovery: {},
                });
                await Promise.resolve();
            });

            await vi.waitFor(() => expect(disconnectActiveServerConnectionIfCurrentSpy).toHaveBeenCalledOnce());
            expect(getCurrentAuth()).toMatchObject({
                isAuthenticated: true,
                credentials: initialCredentials,
            });
            expect(disconnectActiveServerConnectionSpy).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });
});
