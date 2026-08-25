import type { FeatureDecision } from '@happier-dev/protocol';

import { resolvePeerRouteDecision } from '../../route/decision.js';
import type { PeerRouteViabilityRecord } from '../../route/types.js';
import {
    PEER_TCP_TUNNEL_DISABLED_REASONS,
    type PeerTcpTunnelDisabledReason,
} from './disabledReasons.js';

/**
 * The two flows that ride the peer TCP tunnel. `voice_media` is a first-class member: it uses the
 * same loopback tunnel endpoint and the same relay socket, and only its feature gates differ
 * (`resolvePeerRouteFeatureId` in the protocol is the single owner of that mapping).
 */
export type PeerTcpTunnelFlowKind = 'tcp_tunnel' | 'voice_media';

/**
 * The outcome of the caller's direct-route resolution. The failure reason is carried, not dropped:
 * the loopback resolver already knows whether the grant expired, the port was disallowed or the
 * probe binding mismatched, and reporting "server policy" for all of them was the §7.4 defect.
 */
export type PeerTcpTunnelDirectRouteOutcome =
    | Readonly<{ status: 'selected' }>
    | Readonly<{ status: 'unavailable'; reasonCode: string }>;

export type PeerTcpTunnelRouteDecision =
    | Readonly<{
        kind: 'selected';
        flowKind: PeerTcpTunnelFlowKind;
        routeKind: 'loopback_direct' | 'server_relay';
        allowServerRelayFallback: boolean;
      }>
    | Readonly<{
        kind: 'unavailable';
        flowKind: PeerTcpTunnelFlowKind;
        reasonCode: PeerTcpTunnelDisabledReason;
        /**
         * The direct route's own failure reason when it was attempted and failed, preserved even
         * when it is outside this flow's disabled-reason vocabulary (the loopback probe and the
         * grant mint have their own reason enums).
         */
        directRouteReasonCode?: string;
      }>;

export type ResolveTcpTunnelRouteDecisionInput = Readonly<{
    flowKind: PeerTcpTunnelFlowKind;
    /**
     * Pre-resolved feature decisions, not raw feature bits: the feature decision engine is the
     * single owner of dependency closure, so a disabled parent gate arrives here as
     * `blockedBy: 'dependency'` rather than needing a second parent-gate check.
     */
    directPeerDecision: FeatureDecision | null | undefined;
    serverRoutedDecision: FeatureDecision | null | undefined;
    directRoute: PeerTcpTunnelDirectRouteOutcome;
}>;

function isEnabled(decision: FeatureDecision | null | undefined): boolean {
    return decision?.state === 'enabled';
}

function isUnresolved(decision: FeatureDecision | null | undefined): boolean {
    return !decision || decision.state === 'unknown';
}

function isBlockedByDependency(decision: FeatureDecision | null | undefined): boolean {
    return decision?.blockedBy === 'dependency';
}

function asDisabledReason(reasonCode: string): PeerTcpTunnelDisabledReason | null {
    return (PEER_TCP_TUNNEL_DISABLED_REASONS as readonly string[]).includes(reasonCode)
        ? reasonCode as PeerTcpTunnelDisabledReason
        : null;
}

export function resolveTcpTunnelRouteDecision(
    input: ResolveTcpTunnelRouteDecisionInput,
): PeerTcpTunnelRouteDecision {
    const directPeerEnabled = isEnabled(input.directPeerDecision);
    const serverRoutedEnabled = isEnabled(input.serverRoutedDecision);
    const directViability: PeerRouteViabilityRecord = input.directRoute.status === 'selected'
        ? { status: 'viable', checkedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER }
        : {
            status: 'unavailable',
            checkedAt: 0,
            expiresAt: 0,
            failureReason: input.directRoute.reasonCode,
        };

    const routeDecision = resolvePeerRouteDecision({
        flowKind: input.flowKind,
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
            flowKind: input.flowKind,
            routeKind: routeDecision.routeKind === 'server_relay' ? 'server_relay' : 'loopback_direct',
            allowServerRelayFallback: routeDecision.routeKind === 'server_relay' ? true : serverRoutedEnabled,
        };
    }

    if (isUnresolved(input.directPeerDecision) && isUnresolved(input.serverRoutedDecision)) {
        return { kind: 'unavailable', flowKind: input.flowKind, reasonCode: 'server_features_unavailable' };
    }

    if (isBlockedByDependency(input.directPeerDecision) || isBlockedByDependency(input.serverRoutedDecision)) {
        return { kind: 'unavailable', flowKind: input.flowKind, reasonCode: 'blocked_by_server_policy' };
    }

    if (directPeerEnabled && input.directRoute.status === 'unavailable') {
        return {
            kind: 'unavailable',
            flowKind: input.flowKind,
            reasonCode: asDisabledReason(input.directRoute.reasonCode) ?? 'route_unavailable',
            directRouteReasonCode: input.directRoute.reasonCode,
        };
    }

    return {
        kind: 'unavailable',
        flowKind: input.flowKind,
        reasonCode: serverRoutedEnabled ? 'route_unavailable' : 'relay_disabled_by_server_policy',
    };
}
