import type { PeerEndpointMechanism, PeerRouteKind } from '../route/types.js';

export type DirectPeerRouteKind = Exclude<PeerRouteKind, 'server_relay'>;

export function resolvePeerRouteKindForEndpointMechanism(
    mechanism: PeerEndpointMechanism,
): PeerRouteKind {
    switch (mechanism) {
        case 'loopback_http':
        case 'loopback_ws':
            return 'loopback_direct';
        case 'lan_ws':
            return 'lan_direct';
        case 'tailscale_serve_https':
        case 'tailscale_serve_wss':
            return 'tailscale_serve_direct';
        case 'server_socket_io':
            return 'server_relay';
    }
}
