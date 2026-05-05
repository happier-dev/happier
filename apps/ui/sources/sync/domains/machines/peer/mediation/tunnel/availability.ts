import type { FeatureDecision } from '@happier-dev/protocol';

import type { PeerLoopbackRouteAvailabilityResult } from '../loopback/resolvePeerLoopbackRouteAvailability';

export type PeerTcpTunnelAvailability =
    | Readonly<{
        kind: 'available';
        routeKind: 'loopback_direct' | 'server_relay';
        endpointFingerprint?: string;
        allowServerRelayFallback: boolean;
      }>
    | Readonly<{
        kind: 'unavailable';
        reasonCode: string;
      }>;

function decisionEnabled(decision: FeatureDecision | null | undefined): boolean {
    return decision?.state === 'enabled';
}

export function resolvePeerTcpTunnelAvailability(input: Readonly<{
    directPeerDecision: FeatureDecision | null | undefined;
    serverRoutedDecision: FeatureDecision | null | undefined;
    loopback: PeerLoopbackRouteAvailabilityResult;
}>): PeerTcpTunnelAvailability {
    const directPeerEnabled = decisionEnabled(input.directPeerDecision);
    const serverRoutedEnabled = decisionEnabled(input.serverRoutedDecision);

    if (directPeerEnabled && input.loopback.kind === 'selected') {
        return {
            kind: 'available',
            routeKind: 'loopback_direct',
            endpointFingerprint: input.loopback.endpointFingerprint,
            allowServerRelayFallback: serverRoutedEnabled,
        };
    }

    if (serverRoutedEnabled) {
        return {
            kind: 'available',
            routeKind: 'server_relay',
            allowServerRelayFallback: true,
        };
    }

    return {
        kind: 'unavailable',
        reasonCode: 'relay_disabled_by_server_policy',
    };
}
