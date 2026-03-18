import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTransferRouteViabilityCache } from './createTransferRouteViabilityCache';

describe('createTransferRouteViabilityCache', () => {
    const now = vi.fn<() => number>();

    beforeEach(() => {
        now.mockReset();
        now.mockReturnValue(1_000);
    });

    it('returns unknown for a route that has not been recorded', () => {
        const cache = createTransferRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 5_000,
        });

        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-a',
        })).toEqual({ status: 'unknown' });
    });

    it('returns a viable entry until the positive ttl expires', () => {
        const cache = createTransferRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 5_000,
        });
        const key = {
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-a',
        } as const;

        cache.recordViable(key);

        expect(cache.read(key)).toEqual({
            status: 'viable',
            checkedAt: 1_000,
            expiresAt: 11_000,
            endpointFingerprint: 'fingerprint-a',
        });

        now.mockReturnValue(11_001);
        expect(cache.read(key)).toEqual({ status: 'unknown' });
    });

    it('returns an unavailable entry until the negative ttl expires', () => {
        const cache = createTransferRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });
        const key = {
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-a',
        } as const;

        cache.recordUnavailable(key, 'network_error');

        expect(cache.read(key)).toEqual({
            status: 'unavailable',
            checkedAt: 1_000,
            expiresAt: 3_000,
            failureReason: 'network_error',
            endpointFingerprint: 'fingerprint-a',
        });

        now.mockReturnValue(3_001);
        expect(cache.read(key)).toEqual({ status: 'unknown' });
    });

    it('treats a different endpoint fingerprint as a different cache entry', () => {
        const cache = createTransferRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });

        cache.recordViable({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-a',
        });

        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-b',
        })).toEqual({ status: 'unknown' });
    });

    it('invalidates matching entries without clearing unrelated routes', () => {
        const cache = createTransferRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });
        const directPeerKey = {
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-a',
        } as const;
        const serverRoutedKey = {
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'server_routed_stream',
        } as const;

        cache.recordUnavailable(directPeerKey, 'network_error');
        cache.recordViable(serverRoutedKey);

        cache.invalidate({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
        });

        expect(cache.read(directPeerKey)).toEqual({ status: 'unknown' });
        expect(cache.read(serverRoutedKey)).toEqual({
            status: 'viable',
            checkedAt: 1_000,
            expiresAt: 11_000,
            endpointFingerprint: undefined,
        });
    });
});
