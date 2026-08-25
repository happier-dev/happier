import { describe, expect, it } from 'vitest';

import {
    resolvePeerRouteKindForEndpointMechanism,
} from './routeKind';

describe('endpoint route-kind mapping', () => {
    it('maps listener mechanisms to final route kinds', () => {
        expect(resolvePeerRouteKindForEndpointMechanism('loopback_http')).toBe('loopback_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('loopback_ws')).toBe('loopback_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('lan_ws')).toBe('lan_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('tailscale_serve_https')).toBe('tailscale_serve_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('tailscale_serve_wss')).toBe('tailscale_serve_direct');
        expect(resolvePeerRouteKindForEndpointMechanism('server_socket_io')).toBe('server_relay');
    });
});
