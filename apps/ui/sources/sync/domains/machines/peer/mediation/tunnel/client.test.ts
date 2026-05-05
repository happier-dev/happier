import { describe, expect, it, vi } from 'vitest';
import { createFeatureDecision, type PeerTcpTunnelOpenV1 } from '@happier-dev/protocol';

type ClientModule = typeof import('./client');

async function loadClientModule(): Promise<ClientModule | null> {
    const modulePath = './client';
    return import(modulePath).catch(() => null) as Promise<ClientModule | null>;
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

const open: PeerTcpTunnelOpenV1 = {
    v: 1,
    kind: 'open',
    tunnelId: 'tun_1',
    targetMachineId: 'machine_1',
    routeKind: 'loopback_direct',
    destination: { host: '127.0.0.1', port: 3000 },
};

describe('openPeerTcpTunnel', () => {
    it('opens a loopback stream after the tunnel open control request succeeds', async () => {
        const mod = await loadClientModule();
        type OpenTunnelForTest = (input: Parameters<NonNullable<typeof mod>['openPeerTcpTunnel']>[0] & {
            openLoopbackStream: (request: Readonly<{ response: unknown; open: PeerTcpTunnelOpenV1 }>) => Promise<unknown>;
        }) => ReturnType<NonNullable<typeof mod>['openPeerTcpTunnel']>;
        const openTunnel = mod?.openPeerTcpTunnel as unknown as OpenTunnelForTest | undefined;
        const resolveLoopback = vi.fn(async () => ({
            kind: 'selected' as const,
            receipt: 'peer.route.selected' as const,
            routeKind: 'loopback_direct' as const,
            flowKind: 'tcp_tunnel' as const,
            endpointFingerprint: 'endpoint_1',
        }));
        const stream = { close: vi.fn(), sendFrame: vi.fn(), onFrame: vi.fn() };
        const openLoopbackStream = vi.fn(async () => stream);
        const postOpen = vi.fn(async () => ({
            v: 1,
            tunnelId: 'tun_1',
            streamPath: '/peer-mediation/v1/tunnel/stream',
            encoding: 'json_base64_v1',
            initialWindowBytes: 1024 * 1024,
            maxFrameBytes: 64 * 1024,
        } as const));
        expect(openTunnel).toBeTypeOf('function');

        await expect(openTunnel?.({
            open,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
            resolveLoopback,
            postOpen,
            openLoopbackStream,
        })).resolves.toMatchObject({
            ok: true,
            routeKind: 'loopback_direct',
            response: {
                streamPath: '/peer-mediation/v1/tunnel/stream',
                encoding: 'json_base64_v1',
            },
            stream,
        });

        expect(resolveLoopback).toHaveBeenCalledWith(expect.objectContaining({
            flowKind: 'tcp_tunnel',
            routeKind: 'loopback_direct',
        }));
        expect(postOpen).toHaveBeenCalledWith(expect.objectContaining({ open }));
        expect(openLoopbackStream).toHaveBeenCalledWith(expect.objectContaining({
            response: expect.objectContaining({
                streamPath: '/peer-mediation/v1/tunnel/stream',
            }),
            open,
        }));
    });

    it('fails closed without posting open when feature decisions make the tunnel unavailable', async () => {
        const mod = await loadClientModule();
        const postOpen = vi.fn();
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        await expect(mod?.openPeerTcpTunnel({
            open,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'route_unavailable',
            })),
            postOpen,
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'relay_disabled_by_server_policy',
        });

        expect(postOpen).not.toHaveBeenCalled();
    });

    it('does not report loopback success when no stream transport adapter is available', async () => {
        const mod = await loadClientModule();
        const postOpen = vi.fn();
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        await expect(mod?.openPeerTcpTunnel({
            open,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
            resolveLoopback: vi.fn(async () => ({
                kind: 'selected' as const,
                receipt: 'peer.route.selected' as const,
                routeKind: 'loopback_direct' as const,
                flowKind: 'tcp_tunnel' as const,
                endpointFingerprint: 'endpoint_1',
            })),
            postOpen,
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'stream_transport_unavailable',
        });

        expect(postOpen).not.toHaveBeenCalled();
    });

    it('uses the server relay stream path instead of posting loopback open when relay is selected', async () => {
        const mod = await loadClientModule();
        type OpenTunnelForTest = (input: Parameters<NonNullable<typeof mod>['openPeerTcpTunnel']>[0] & {
            openServerRelayStream: (request: Readonly<{ open: PeerTcpTunnelOpenV1 }>) => Promise<unknown>;
        }) => ReturnType<NonNullable<typeof mod>['openPeerTcpTunnel']>;
        const openTunnel = mod?.openPeerTcpTunnel as unknown as OpenTunnelForTest | undefined;
        const stream = { close: vi.fn(), sendFrame: vi.fn(), onFrame: vi.fn() };
        const openServerRelayStream = vi.fn(async () => stream);
        const postOpen = vi.fn();
        expect(openTunnel).toBeTypeOf('function');

        await expect(openTunnel?.({
            open,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'route_unavailable',
            })),
            postOpen,
            openServerRelayStream,
        })).resolves.toMatchObject({
            ok: true,
            routeKind: 'server_relay',
            stream,
        });

        expect(postOpen).not.toHaveBeenCalled();
        expect(openServerRelayStream).toHaveBeenCalledWith({
            open: expect.objectContaining({
                routeKind: 'server_relay',
            }),
        });
    });
});
