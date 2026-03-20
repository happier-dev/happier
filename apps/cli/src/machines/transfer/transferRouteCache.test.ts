import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineTransferRouteCache } from './transferRouteCache';

describe('createMachineTransferRouteCache', () => {
    const now = vi.fn<() => number>();

    beforeEach(() => {
        now.mockReset();
        now.mockReturnValue(1_000);
        delete process.env.HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS;
        delete process.env.HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS;
    });

    afterEach(() => {
        delete process.env.HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_POSITIVE_TTL_MS;
        delete process.env.HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS;
    });

    it('treats a different endpoint set as a different direct-peer cache key', () => {
        const cache = createMachineTransferRouteCache({
            serverId: 'server-1',
            now,
        });

        cache.recordDirectPeerRouteUnavailable({
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=1',
                    expiresAt: 10_000,
                },
            ],
        }, 'network_error');

        expect(cache.readDirectPeerRoute({
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46002/machine-transfers/direct/a?token=2',
                    expiresAt: 10_000,
                },
            ],
        })).toEqual({ status: 'unknown' });
    });

    it('expires negative entries using the configured ttl', () => {
        process.env.HAPPIER_MACHINE_TRANSFER_ROUTE_CACHE_NEGATIVE_TTL_MS = '25';
        const cache = createMachineTransferRouteCache({
            serverId: 'server-1',
            now,
        });
        const route = {
            remoteMachineId: 'machine-source',
            endpointCandidates: [
                {
                    kind: 'http' as const,
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/a?token=1',
                    expiresAt: 10_000,
                },
            ],
        };

        cache.recordDirectPeerRouteUnavailable(route, 'network_error');

        expect(cache.readDirectPeerRoute(route)).toEqual(expect.objectContaining({
            status: 'unavailable',
            failureReason: 'network_error',
        }));

        now.mockReturnValue(1_026);
        expect(cache.readDirectPeerRoute(route)).toEqual({ status: 'unknown' });
    });
});
