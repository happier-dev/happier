import { TransferEndpointCandidateSchema, type TransferEndpointCandidate } from '@happier-dev/protocol';

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

function isLoopbackHostname(hostname: string): boolean {
    const lowerHostname = hostname.toLowerCase();
    const normalized = lowerHostname.startsWith('[') && lowerHostname.endsWith(']')
        ? lowerHostname.slice(1, -1)
        : lowerHostname;
    return normalized === 'localhost'
        || normalized === '::1'
        || normalized.startsWith('127.');
}

export function resolvePeerRouteKindForEndpointCandidate(
    candidate: TransferEndpointCandidate,
): DirectPeerRouteKind | null {
    const parsed = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
        return null;
    }

    let url: URL;
    try {
        url = new URL(parsed.data.url);
    } catch {
        return null;
    }

    if (parsed.data.kind === 'https') {
        // V1 direct-transfer HTTPS candidates are produced by Tailscale Serve.
        // Mechanism-based mapping remains authoritative when a listener mechanism is available.
        return 'tailscale_serve_direct';
    }

    return isLoopbackHostname(url.hostname) ? 'loopback_direct' : null;
}

export function resolvePeerRouteKindsForEndpointCandidates(
    candidates: readonly TransferEndpointCandidate[],
): readonly DirectPeerRouteKind[] {
    const routeKinds: DirectPeerRouteKind[] = [];
    for (const candidate of candidates) {
        const routeKind = resolvePeerRouteKindForEndpointCandidate(candidate);
        if (routeKind && !routeKinds.includes(routeKind)) {
            routeKinds.push(routeKind);
        }
    }
    return routeKinds;
}
