import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPeerRouteViabilityCache } from './viability';

describe('createPeerRouteViabilityCache', () => {
    const now = vi.fn<() => number>();

    beforeEach(() => {
        now.mockReset();
        now.mockReturnValue(1_000);
    });

    it('returns unknown for a route that has not been recorded', () => {
        const cache = createPeerRouteViabilityCache({
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
        const cache = createPeerRouteViabilityCache({
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

    it('invalidates matching entries without clearing unrelated routes', () => {
        const cache = createPeerRouteViabilityCache({
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

    it('keeps route viability entries isolated by server id across restart boundaries', () => {
        const cache = createPeerRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });
        const serverOneKey = {
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-a',
        } as const;
        const serverTwoKey = {
            serverId: 'server-2',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
            endpointFingerprint: 'fingerprint-a',
        } as const;

        cache.recordUnavailable(serverOneKey, 'network_error');
        cache.recordViable(serverTwoKey);

        cache.invalidate({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'direct_peer',
        });

        expect(cache.read(serverOneKey)).toEqual({ status: 'unknown' });
        expect(cache.read(serverTwoKey)).toEqual({
            status: 'viable',
            checkedAt: 1_000,
            expiresAt: 11_000,
            endpointFingerprint: 'fingerprint-a',
        });
    });

    it('keeps route viability entries isolated by flow kind', () => {
        const cache = createPeerRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });
        const boundedTransferKey = {
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'fingerprint-a',
        } as const;
        const tcpTunnelKey = {
            ...boundedTransferKey,
            flowKind: 'tcp_tunnel',
        } as const;

        cache.recordViable(boundedTransferKey);

        expect(cache.read(tcpTunnelKey)).toEqual({ status: 'unknown' });
        expect(cache.read(boundedTransferKey)).toEqual({
            status: 'viable',
            checkedAt: 1_000,
            expiresAt: 11_000,
            endpointFingerprint: 'fingerprint-a',
        });
    });

    it('treats the legacy server_routed_stream route kind as the canonical relay route kind', () => {
        const cache = createPeerRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });

        cache.recordViable({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'server_routed_stream',
        });

        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'server_relay_stream',
        })).toEqual({
            status: 'viable',
            checkedAt: 1_000,
            expiresAt: 11_000,
            endpointFingerprint: undefined,
        });
    });

    it('treats server_relay and legacy stream aliases as the same relay cache key', () => {
        const cache = createPeerRouteViabilityCache({
            now,
            positiveTtlMs: 10_000,
            negativeTtlMs: 2_000,
        });

        cache.recordViable({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'server_relay',
        });

        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'server_routed_stream' as never,
        })).toEqual({
            status: 'viable',
            checkedAt: 1_000,
            expiresAt: 11_000,
            endpointFingerprint: undefined,
        });

        expect(cache.read({
            serverId: 'server-1',
            targetMachineId: 'machine-1',
            routeKind: 'server_relay_stream' as never,
        })).toEqual({
            status: 'viable',
            checkedAt: 1_000,
            expiresAt: 11_000,
            endpointFingerprint: undefined,
        });
    });
});
