import { describe, expect, it } from 'vitest';

import { resolveDirectRouteGrantCachePolicy } from './cachePolicy';

describe('resolveDirectRouteGrantCachePolicy', () => {
    it('uses FD-0050 TTL defaults for transfer and direct-route flows', () => {
        expect(resolveDirectRouteGrantCachePolicy({
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            scopeMode: 'single',
        }).ttlMs).toBe(10 * 60_000);

        expect(resolveDirectRouteGrantCachePolicy({
            flowKind: 'machine_rpc',
            routeKind: 'loopback_direct',
        }).ttlMs).toBe(5 * 60_000);

        expect(resolveDirectRouteGrantCachePolicy({
            flowKind: 'tcp_tunnel',
            routeKind: 'lan_direct',
        }).ttlMs).toBe(15 * 60_000);

        expect(resolveDirectRouteGrantCachePolicy({
            flowKind: 'live_stream',
            routeKind: 'tailscale_serve_direct',
        }).ttlMs).toBe(10 * 60_000);
    });

    it('clamps scoped transfer TTL overrides into the 5-30 minute bound', () => {
        expect(resolveDirectRouteGrantCachePolicy({
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            scopeMode: 'scope',
            requestedTtlMs: 60_000,
        }).ttlMs).toBe(5 * 60_000);

        expect(resolveDirectRouteGrantCachePolicy({
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
            scopeMode: 'scope',
            requestedTtlMs: 60 * 60_000,
        }).ttlMs).toBe(30 * 60_000);
    });
});
