import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';

import { requireLocalSessionVisibleForRoute } from './localSessionRouteReadiness';

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
