import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';

import * as localSessionRouteReadiness from './localSessionRouteReadiness';

const {
    requireLocalSessionVisibleForRoute,
    requireSpawnedSessionVisibleForRoute,
} = localSessionRouteReadiness;

describe('requireLocalSessionVisibleForRoute', () => {
    it('checks a route-specific readiness predicate once after the canonical hydration attempt', async () => {
        const stored = {} as Session;
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => ({ kind: 'available' }));
        const isLocalSessionReady = vi.fn(() => true);

        await expect(requireLocalSessionVisibleForRoute({
            sessionId: 'child',
            serverId: 'server-a',
            getStoredSession: () => stored,
            ensureSessionVisibleForMessageRoute,
            isLocalSessionReady,
        })).resolves.toBe(stored);

        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledOnce();
        expect(isLocalSessionReady).toHaveBeenCalledOnce();
    });

    it('retries bounded post-spawn propagation through the canonical route-readiness owner', async () => {
        vi.useFakeTimers();
        try {
            const stored = {} as Session;
            let visibleSession: Session | null = null;
            const ensureSessionVisibleForMessageRoute = vi.fn(async () => {
                if (ensureSessionVisibleForMessageRoute.mock.calls.length >= 2) {
                    visibleSession = stored;
                    return { kind: 'available' };
                }
                return { kind: 'missing', errorCode: 'not_found' };
            });

            const visibility = requireSpawnedSessionVisibleForRoute({
                sessionId: 'spawned-session',
                serverId: 'server-a',
                getStoredSession: () => visibleSession,
                ensureSessionVisibleForMessageRoute,
            });

            await vi.advanceTimersByTimeAsync(250);

            await expect(visibility).resolves.toBe(stored);
            expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects a locally visible session that fails the route predicate without retry polling', async () => {
        const ensureSessionVisibleForMessageRoute = vi.fn(async () => ({ kind: 'available' }));

        await expect(requireLocalSessionVisibleForRoute({
            sessionId: 'wrong-child',
            getStoredSession: () => ({} as Session),
            ensureSessionVisibleForMessageRoute,
            isLocalSessionReady: () => false,
        })).rejects.toThrow('Created session is not available locally');

        expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledOnce();
    });
});
