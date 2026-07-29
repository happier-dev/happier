import { createFeatureDecision } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

function featureDecision(featureId: 'machines.tunnel.directPeer' | 'machines.tunnel.serverRouted', enabled: boolean) {
    return createFeatureDecision({
        featureId,
        state: enabled ? 'enabled' : 'disabled',
        blockedBy: enabled ? null : 'server',
        blockerCode: enabled ? 'none' : 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 1,
        scope: { scopeKind: 'runtime' },
    });
}

describe('resolvePeerTcpTunnelAvailability', () => {
    it('selects loopback direct when direct peer routing and loopback availability are both present', async () => {
        const mod = await import('./availability').catch((importError: unknown) => ({ importError }));
        expect(mod).toHaveProperty('resolvePeerTcpTunnelAvailability');
        if (!('resolvePeerTcpTunnelAvailability' in mod)) return;

        expect(mod.resolvePeerTcpTunnelAvailability({
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
            loopback: {
                kind: 'selected',
                receipt: 'peer.route.selected',
                routeKind: 'loopback_direct',
                flowKind: 'tcp_tunnel',
                endpointFingerprint: 'endpoint_1',
            },
        })).toEqual({
            kind: 'available',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'endpoint_1',
            allowServerRelayFallback: true,
        });
    });

    it('falls back to server relay only when relay is enabled', async () => {
        const mod = await import('./availability').catch((importError: unknown) => ({ importError }));
        expect(mod).toHaveProperty('resolvePeerTcpTunnelAvailability');
        if (!('resolvePeerTcpTunnelAvailability' in mod)) return;

        expect(mod.resolvePeerTcpTunnelAvailability({
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
            loopback: {
                kind: 'fallback',
                receipt: 'peer.route.fallback',
                reasonCode: 'route_unavailable',
            },
        })).toEqual({
            kind: 'available',
            routeKind: 'server_relay',
            allowServerRelayFallback: true,
        });
    });
});
