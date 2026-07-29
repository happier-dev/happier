export type PeerFlowKind =
    | 'bounded_transfer'
    | 'tcp_tunnel'
    | 'live_stream'
    | 'machine_rpc';

export type PeerRouteKind =
    | 'loopback_direct'
    | 'lan_direct'
    | 'tailscale_serve_direct'
    | 'server_relay';

export type PeerEndpointTransport =
    | 'http'
    | 'https'
    | 'ws'
    | 'wss'
    | 'socket_io';

export type PeerEndpointMechanism =
    | 'loopback_http'
    | 'tailscale_serve_https'
    | 'loopback_ws'
    | 'lan_ws'
    | 'tailscale_serve_wss'
    | 'server_socket_io';

export type PeerRouteUnavailableReason = 'no_routes_available';

export type PeerEndpointCandidate = Readonly<{
    transport: PeerEndpointTransport;
    mechanism: PeerEndpointMechanism;
    url: string;
    endpointFingerprint?: string;
}>;

export type PeerRouteViabilityRecord =
    | Readonly<{
        status: 'unknown';
    }>
    | Readonly<{
        status: 'viable';
        checkedAt: number;
        expiresAt: number;
        endpointFingerprint?: string;
    }>
    | Readonly<{
        status: 'unavailable';
        checkedAt: number;
        expiresAt: number;
        failureReason: string;
        endpointFingerprint?: string;
    }>;

export type PeerRouteCandidate = Readonly<{
    routeKind: PeerRouteKind;
    enabled: boolean;
    viability?: PeerRouteViabilityRecord;
    endpoint?: PeerEndpointCandidate;
}>;

export type PeerRouteDecision =
    | Readonly<{
        kind: 'selected';
        flowKind: PeerFlowKind;
        routeKind: PeerRouteKind;
        endpoint?: PeerEndpointCandidate;
        viability?: PeerRouteViabilityRecord;
    }>
    | Readonly<{
        kind: 'unavailable';
        flowKind: PeerFlowKind;
        reasonCode: PeerRouteUnavailableReason;
    }>;
