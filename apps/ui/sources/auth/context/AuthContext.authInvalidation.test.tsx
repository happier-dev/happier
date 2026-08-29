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
const syncSwitchServerSpy = vi.hoisted(() => vi.fn(async () => {}));
const subscribeActiveServerSpy = vi.hoisted(() => vi.fn());
const subscribeAuthCredentialsInvalidationSpy = vi.hoisted(() => vi.fn());
const startConcurrentSessionCacheSyncSpy = vi.hoisted(() => vi.fn());
const stopConcurrentSessionCacheSyncSpy = vi.hoisted(() => vi.fn());

let authInvalidationListener: ((event: unknown) => void | Promise<void>) | null = null;

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerSpy,
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

    it('refreshes focused auth without stopping secondary-server cache continuity', async () => {
        const { AuthProvider, getCurrentAuth } = await import('./AuthContext');

        const screen = await renderScreen(
            React.createElement(AuthProvider, {
                initialCredentials: { token: 'token-a', secret: 'secret-a' },
                children: React.createElement(React.Fragment, null),
            }),
        );

        try {
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
            expect(startConcurrentSessionCacheSyncSpy).toHaveBeenCalledTimes(1);
            expect(subscribeAuthCredentialsInvalidationSpy).toHaveBeenCalledTimes(1);
            expect(authInvalidationListener).toBeTypeOf('function');

            await act(async () => {
                await authInvalidationListener?.({
                    serverId: 'server-a',
                    serverUrl: 'http://localhost:3012',
                    token: 'token-a',
                });
            });

            await vi.waitFor(() => {
                expect(switchConnectionToActiveServerSpy).toHaveBeenCalledTimes(1);
                expect(syncSwitchServerSpy).toHaveBeenCalledWith(null);
                expect(getCurrentAuth()?.isAuthenticated).toBe(false);
            });
            expect(stopConcurrentSessionCacheSyncSpy).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
        expect(stopConcurrentSessionCacheSyncSpy).toHaveBeenCalledTimes(1);
    });
});
