import { describe, expect, it } from 'vitest';
import { createFeatureDecision } from '@happier-dev/protocol';

type AvailabilityModule = typeof import('./availability');

async function loadAvailabilityModule(): Promise<AvailabilityModule | null> {
    const modulePath = './availability';
    return import(modulePath).catch(() => null) as Promise<AvailabilityModule | null>;
}

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
    it('selects loopback direct when feature decisions allow direct and loopback is selected', async () => {
        const mod = await loadAvailabilityModule();

        expect(mod?.resolvePeerTcpTunnelAvailability({
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
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
            allowServerRelayFallback: false,
        });
    });

    it('reports relay disabled by server policy when direct is unavailable and relay decision is disabled', async () => {
        const mod = await loadAvailabilityModule();

        expect(mod?.resolvePeerTcpTunnelAvailability({
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
            loopback: {
                kind: 'fallback',
                receipt: 'peer.route.fallback',
                reasonCode: 'route_unavailable',
            },
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'relay_disabled_by_server_policy',
        });
    });
});
