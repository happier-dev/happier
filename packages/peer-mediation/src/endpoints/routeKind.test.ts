import { describe, expect, it } from 'vitest';

import {
    resolvePeerRouteKindForEndpointCandidate,
    resolvePeerRouteKindForEndpointMechanism,
    resolvePeerRouteKindsForEndpointCandidates,
} from './routeKind';

describe('endpoint route-kind mapping', () => {
    it('maps listener mechanisms to final route kinds', () => {
        expect(resolvePeerRouteKindForEndpointMechanism('loopback_http')).toBe('loopback_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('lan_ws')).toBe('lan_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('tailscale_serve_https')).toBe('tailscale_serve_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('server_socket_io')).toBe('server_relay');
    });

    it('maps direct transfer endpoint candidates to final route kinds', () => {
        expect(resolvePeerRouteKindForEndpointCandidate({
            kind: 'http',
            url: 'http://127.0.0.1:46001/machine-transfers/direct/a',
            expiresAt: 10_000,
        })).toBe('loopback_direct');
        expect(resolvePeerRouteKindForEndpointCandidate({
            kind: 'http',
            url: 'http://[::1]:46001/machine-transfers/direct/a',
            expiresAt: 10_000,
        })).toBe('loopback_direct');
        expect(resolvePeerRouteKindForEndpointCandidate({
            kind: 'http',
            url: 'http://192.168.1.20:46001/machine-transfers/direct/a',
            expiresAt: 10_000,
        })).toBeNull();
        expect(resolvePeerRouteKindForEndpointCandidate({
            kind: 'https',
            url: 'https://happier-tailnet.ts.net/machine-transfers/direct/a',
            expiresAt: 10_000,
        })).toBe('tailscale_serve_direct');
    });

    it('deduplicates route kinds while preserving candidate order', () => {
        expect(resolvePeerRouteKindsForEndpointCandidates([
            {
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/a',
                expiresAt: 10_000,
            },
            {
                kind: 'http',
                url: 'http://localhost:46001/machine-transfers/direct/a',
                expiresAt: 10_000,
            },
            {
                kind: 'https',
                url: 'https://happier-tailnet.ts.net/machine-transfers/direct/a',
                expiresAt: 10_000,
            },
        ])).toEqual(['loopback_direct', 'tailscale_serve_direct']);
    });
});
