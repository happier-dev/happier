import type { PeerFlowKindV1, PeerRouteKindV1 } from '@happier-dev/protocol';

/**
 * One flow-kind and one route-kind vocabulary across the whole substrate. These were re-declared
 * here and had already drifted: the protocol declares five flow kinds and this copy declared four,
 * omitting `voice_media` — the substrate's most-used flow (§7.5). Aliasing the protocol types makes
 * a future divergence impossible rather than merely unlikely.
 */
export type PeerFlowKind = PeerFlowKindV1;

export type PeerRouteKind = PeerRouteKindV1;

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
