import { describe, expect, it } from 'vitest';

import {
    isSessionRouteInAuthRecoverySubtree,
    resolveSessionRouteAuthRecoveryState,
    shouldNormalizeSessionRouteToAuthRecoveryBase,
} from './sessionRouteAuthRecovery';

describe('resolveSessionRouteAuthRecoveryState', () => {
    it('uses the explicit route server id when matching an auth sync error', () => {
        const state = resolveSessionRouteAuthRecoveryState({
            routeParams: { id: 's1', serverId: 'server-b' },
            activeServerId: 'server-a',
            endpointStatus: 'online',
            syncError: {
                message: 'Invalid token',
                kind: 'auth',
                serverId: 'server-b',
            },
        });

        expect(state.currentRouteServerId).toBe('server-b');
        expect(state.baseHref).toBe('/session/s1?serverId=server-b');
        expect(state.authSurfaceState).toEqual({ message: 'Invalid token' });
    });

    it('does not inherit active-server auth_failed for a different explicit route server', () => {
        const state = resolveSessionRouteAuthRecoveryState({
            routeParams: { id: 's1', serverId: 'server-b' },
            activeServerId: 'server-a',
            endpointStatus: 'auth_failed',
            syncError: null,
        });

        expect(state.authSurfaceState).toBeNull();
    });
});

describe('session route auth recovery subtree helpers', () => {
    it('recognizes nested stale-auth routes inside the base session subtree', () => {
        const authRecovery = resolveSessionRouteAuthRecoveryState({
            routeParams: { id: 's1', serverId: 'server-active' },
            activeServerId: 'server-active',
            endpointStatus: 'auth_failed',
            syncError: null,
        });

        expect(isSessionRouteInAuthRecoverySubtree({
            pathname: '/session/s1/details',
            authRecovery,
        })).toBe(true);
        expect(shouldNormalizeSessionRouteToAuthRecoveryBase({
            pathname: '/session/s1/details',
            authRecovery,
        })).toBe(true);
        expect(shouldNormalizeSessionRouteToAuthRecoveryBase({
            pathname: '/session/s1',
            authRecovery,
        })).toBe(false);
    });
});
