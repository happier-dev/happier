import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol';

type TunnelRouteModule = typeof import('./route');

async function loadTunnelRouteModule(): Promise<TunnelRouteModule | null> {
    const modulePath = './route.js';
    return import(modulePath).catch(() => null) as Promise<TunnelRouteModule | null>;
}

function createFeatures(params?: Readonly<{
    tunnelEnabled?: boolean;
    directPeerEnabled?: boolean;
    serverRoutedEnabled?: boolean;
}>) {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                tunnel: {
                    enabled: params?.tunnelEnabled ?? true,
                    directPeer: { enabled: params?.directPeerEnabled ?? true },
                    serverRouted: { enabled: params?.serverRoutedEnabled ?? false },
                },
            },
        },
        capabilities: {},
    });
}

describe('resolveTcpTunnelRouteDecision', () => {
    it('selects loopback direct before server relay when both are enabled and loopback is viable', async () => {
        const mod = await loadTunnelRouteModule();

        expect(mod?.resolveTcpTunnelRouteDecision({
            serverFeatures: createFeatures({ serverRoutedEnabled: true }),
            loopbackAvailable: true,
        })).toEqual({
            kind: 'selected',
            flowKind: 'tcp_tunnel',
            routeKind: 'loopback_direct',
            allowServerRelayFallback: true,
        });
    });

    it('falls back to server relay only when the server-routed tunnel gate is enabled', async () => {
        const mod = await loadTunnelRouteModule();

        expect(mod?.resolveTcpTunnelRouteDecision({
            serverFeatures: createFeatures({ serverRoutedEnabled: true }),
            loopbackAvailable: false,
        })).toEqual({
            kind: 'selected',
            flowKind: 'tcp_tunnel',
            routeKind: 'server_relay',
            allowServerRelayFallback: true,
        });

        expect(mod?.resolveTcpTunnelRouteDecision({
            serverFeatures: createFeatures({ serverRoutedEnabled: false }),
            loopbackAvailable: false,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'relay_disabled_by_server_policy',
        });
    });
});
