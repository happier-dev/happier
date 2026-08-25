import { describe, expect, it } from 'vitest';

import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';

import { resolveTcpTunnelRouteDecision } from './route';

function enabled(featureId: FeatureId): FeatureDecision {
    return {
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
        diagnostics: [],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
    };
}

function disabledByServer(featureId: FeatureId): FeatureDecision {
    return {
        featureId,
        state: 'disabled',
        blockedBy: 'server',
        blockerCode: 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
    };
}

function disabledByDependency(featureId: FeatureId): FeatureDecision {
    return {
        featureId,
        state: 'disabled',
        blockedBy: 'dependency',
        blockerCode: 'dependency_disabled',
        diagnostics: [],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
    };
}

const DIRECT = 'machines.tunnel.directPeer' as FeatureId;
const RELAY = 'machines.tunnel.serverRouted' as FeatureId;
const VOICE_RELAY = 'machines.liveStream.serverRouted' as FeatureId;

describe('resolveTcpTunnelRouteDecision', () => {
    it('selects loopback direct before server relay when both are enabled and the direct route is viable', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: enabled(DIRECT),
            serverRoutedDecision: enabled(RELAY),
            directRoute: { status: 'selected' },
        })).toEqual({
            kind: 'selected',
            flowKind: 'tcp_tunnel',
            routeKind: 'loopback_direct',
            allowServerRelayFallback: true,
        });
    });

    it('falls back to server relay only when the server-routed gate is enabled', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: enabled(DIRECT),
            serverRoutedDecision: enabled(RELAY),
            directRoute: { status: 'unavailable', reasonCode: 'route_unavailable' },
        })).toEqual({
            kind: 'selected',
            flowKind: 'tcp_tunnel',
            routeKind: 'server_relay',
            allowServerRelayFallback: true,
        });
    });

    it('reports the direct route failure reason instead of a blanket server-policy denial', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: enabled(DIRECT),
            serverRoutedDecision: disabledByServer(RELAY),
            directRoute: { status: 'unavailable', reasonCode: 'grant_expired' },
        })).toEqual({
            kind: 'unavailable',
            flowKind: 'tcp_tunnel',
            reasonCode: 'grant_expired',
            directRouteReasonCode: 'grant_expired',
        });

        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: enabled(DIRECT),
            serverRoutedDecision: disabledByServer(RELAY),
            directRoute: { status: 'unavailable', reasonCode: 'destination_port_not_allowed' },
        })).toEqual({
            kind: 'unavailable',
            flowKind: 'tcp_tunnel',
            reasonCode: 'destination_port_not_allowed',
            directRouteReasonCode: 'destination_port_not_allowed',
        });
    });

    it('keeps an out-of-vocabulary direct failure reason rather than discarding it', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: enabled(DIRECT),
            serverRoutedDecision: disabledByServer(RELAY),
            directRoute: { status: 'unavailable', reasonCode: 'grant_bad_signature' },
        })).toEqual({
            kind: 'unavailable',
            flowKind: 'tcp_tunnel',
            reasonCode: 'route_unavailable',
            directRouteReasonCode: 'grant_bad_signature',
        });
    });

    it('reports relay_disabled_by_server_policy only when the relay gate is the actual blocker', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: disabledByServer(DIRECT),
            serverRoutedDecision: disabledByServer(RELAY),
            directRoute: { status: 'unavailable', reasonCode: 'grant_expired' },
        })).toEqual({
            kind: 'unavailable',
            flowKind: 'tcp_tunnel',
            reasonCode: 'relay_disabled_by_server_policy',
        });
    });

    it('reports the parent gate as blocked_by_server_policy when dependency closure disabled the route', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: disabledByDependency(DIRECT),
            serverRoutedDecision: disabledByDependency(RELAY),
            directRoute: { status: 'unavailable', reasonCode: 'route_unavailable' },
        })).toEqual({
            kind: 'unavailable',
            flowKind: 'tcp_tunnel',
            reasonCode: 'blocked_by_server_policy',
        });
    });

    it('reports server_features_unavailable when no decision could be resolved', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'tcp_tunnel',
            directPeerDecision: null,
            serverRoutedDecision: null,
            directRoute: { status: 'unavailable', reasonCode: 'route_unavailable' },
        })).toEqual({
            kind: 'unavailable',
            flowKind: 'tcp_tunnel',
            reasonCode: 'server_features_unavailable',
        });
    });

    it('resolves the voice_media flow through the same owner and reports its own flow kind', () => {
        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'voice_media',
            directPeerDecision: enabled(DIRECT),
            serverRoutedDecision: null,
            directRoute: { status: 'selected' },
        })).toEqual({
            kind: 'selected',
            flowKind: 'voice_media',
            routeKind: 'loopback_direct',
            allowServerRelayFallback: false,
        });

        expect(resolveTcpTunnelRouteDecision({
            flowKind: 'voice_media',
            directPeerDecision: null,
            serverRoutedDecision: enabled(VOICE_RELAY),
            directRoute: { status: 'unavailable', reasonCode: 'direct_route_skipped' },
        })).toEqual({
            kind: 'selected',
            flowKind: 'voice_media',
            routeKind: 'server_relay',
            allowServerRelayFallback: true,
        });
    });
});
