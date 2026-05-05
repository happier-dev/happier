import { readServerEnabledBit, type FeaturesResponse } from '@happier-dev/protocol';

import { resolvePeerRouteDecision } from '../../route/decision.js';
import type { PeerRouteViabilityRecord } from '../../route/types.js';
import type { PeerTcpTunnelDisabledReason } from './disabledReasons.js';

export type PeerTcpTunnelRouteDecision =
    | Readonly<{
        kind: 'selected';
        flowKind: 'tcp_tunnel';
        routeKind: 'loopback_direct' | 'server_relay';
        allowServerRelayFallback: boolean;
      }>
    | Readonly<{
        kind: 'unavailable';
        reasonCode: PeerTcpTunnelDisabledReason;
      }>;

export function resolveTcpTunnelRouteDecision(input: Readonly<{
    serverFeatures?: FeaturesResponse | null;
    loopbackAvailable: boolean;
}>): PeerTcpTunnelRouteDecision {
    if (!input.serverFeatures) {
        return { kind: 'unavailable', reasonCode: 'server_features_unavailable' };
    }

    const tunnelEnabled = readServerEnabledBit(input.serverFeatures, 'machines.tunnel') === true;
    if (!tunnelEnabled) {
        return { kind: 'unavailable', reasonCode: 'blocked_by_server_policy' };
    }

    const directPeerEnabled = readServerEnabledBit(input.serverFeatures, 'machines.tunnel.directPeer') === true;
    const serverRoutedEnabled = readServerEnabledBit(input.serverFeatures, 'machines.tunnel.serverRouted') === true;
    const directViability: PeerRouteViabilityRecord = input.loopbackAvailable
        ? { status: 'viable', checkedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER }
        : { status: 'unavailable', checkedAt: 0, expiresAt: 0, failureReason: 'route_unavailable' };

    const routeDecision = resolvePeerRouteDecision({
        flowKind: 'tcp_tunnel',
        preferredRouteKinds: ['loopback_direct', 'server_relay'],
        candidates: [
            {
                routeKind: 'loopback_direct',
                enabled: directPeerEnabled,
                viability: directViability,
            },
            {
                routeKind: 'server_relay',
                enabled: serverRoutedEnabled,
            },
        ],
    });

    if (routeDecision.kind === 'selected') {
        return {
            kind: 'selected',
            flowKind: 'tcp_tunnel',
            routeKind: routeDecision.routeKind === 'server_relay' ? 'server_relay' : 'loopback_direct',
            allowServerRelayFallback: routeDecision.routeKind === 'server_relay' ? true : serverRoutedEnabled,
        };
    }

    return {
        kind: 'unavailable',
        reasonCode: serverRoutedEnabled ? 'route_unavailable' : 'relay_disabled_by_server_policy',
    };
}
