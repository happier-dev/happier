import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    createFeatureDecision,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type DynamicModule = Record<string, unknown>;

async function loadModule(path: string): Promise<DynamicModule> {
    return import(path).catch((importError: unknown) => ({ importError }));
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

const relaySocketId = 'relay_socket_1';
const relayOpen: PeerTcpTunnelOpenV1 = {
    ...open,
    routeKind: 'server_relay',
    relayAuthorization: {
        payload: {
            v: 2,
            grantId: 'relay_grant_1',
            accountId: 'user_1',
            targetMachineId: 'machine_1',
            flowKind: 'tcp_tunnel',
            routeKind: 'server_relay',
            tunnelId: 'tun_1',
            relaySocketId,
            destination: { host: '127.0.0.1', port: 3000 },
            capProfileId: 'interactive',
            maxFrameBytes: 64 * 1024,
            maxIdleMs: 30_000,
            maxDurationMs: 300_000,
            iat: 1_000,
            exp: 301_000,
            aud: 'happier-tcp-tunnel-relay-authorization',
        },
        signature: {
            keyId: 'relay_key_1',
            alg: 'Ed25519',
            valueBase64Url: 'AbCdEf012_-',
        },
    },
};

describe('openPeerTcpTunnel', () => {
    it('exports the canonical loopback and relay stream owners from the tunnel entrypoint', async () => {
        const mod = await loadModule('./index');

        expect(mod.openPeerTcpTunnel).toBeTypeOf('function');
        expect(mod.openPeerTcpTunnelLoopbackStream).toBeTypeOf('function');
        expect(mod.openPeerTcpTunnelRelayStream).toBeTypeOf('function');
    });

    it('opens a loopback stream after the tunnel open control request succeeds', async () => {
        const mod = await loadModule('./client');
        const openPeerTcpTunnel = mod.openPeerTcpTunnel;
        expect(openPeerTcpTunnel).toBeTypeOf('function');
        if (typeof openPeerTcpTunnel !== 'function') return;

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

        await expect(openPeerTcpTunnel({
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

    it('reports the direct route failure reason on denial instead of a blanket server-policy code', async () => {
        const mod = await loadModule('./client');
        const openPeerTcpTunnel = mod.openPeerTcpTunnel;
        expect(openPeerTcpTunnel).toBeTypeOf('function');
        if (typeof openPeerTcpTunnel !== 'function') return;

        await expect(openPeerTcpTunnel({
            open,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'grant_expired',
            })),
            postOpen: vi.fn(),
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'grant_expired',
            directRouteReasonCode: 'grant_expired',
        });

        await expect(openPeerTcpTunnel({
            open,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'destination_port_not_allowed',
            })),
            postOpen: vi.fn(),
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'destination_port_not_allowed',
            directRouteReasonCode: 'destination_port_not_allowed',
        });

        await expect(openPeerTcpTunnel({
            open,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', false),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', false),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'grant_expired',
            })),
            postOpen: vi.fn(),
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'relay_disabled_by_server_policy',
        });
    });

    it('uses the server relay stream path and preserves the negotiated binary encoding', async () => {
        const mod = await loadModule('./client');
        const openPeerTcpTunnel = mod.openPeerTcpTunnel;
        expect(openPeerTcpTunnel).toBeTypeOf('function');
        if (typeof openPeerTcpTunnel !== 'function') return;

        const stream = { close: vi.fn(), sendFrame: vi.fn(), onFrame: vi.fn() };
        const openServerRelayStream = vi.fn(async () => stream);
        const postOpen = vi.fn();

        await expect(openPeerTcpTunnel({
            open: {
                ...relayOpen,
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'route_unavailable',
            })),
            postOpen,
            openServerRelayStream,
            serverRelaySocket: {
                socketId: relaySocketId,
                send: vi.fn(),
                onEnvelope: vi.fn(() => () => {}),
            },
        })).resolves.toMatchObject({
            ok: true,
            routeKind: 'server_relay',
            response: {
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
            stream,
        });

        expect(postOpen).not.toHaveBeenCalled();
        expect(openServerRelayStream).toHaveBeenCalledWith({
            open: expect.objectContaining({
                routeKind: 'server_relay',
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            }),
        });
    });

    it('opens the production server relay adapter when relay socket dependencies are provided', async () => {
        const mod = await loadModule('./client');
        const openPeerTcpTunnel = mod.openPeerTcpTunnel;
        expect(openPeerTcpTunnel).toBeTypeOf('function');
        if (typeof openPeerTcpTunnel !== 'function') return;

        const sent: unknown[] = [];
        const relayHandlers = new Set<(envelope: unknown) => void>();

        const result = await openPeerTcpTunnel({
            open: relayOpen,
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'route_unavailable',
            })),
            postOpen: vi.fn(),
            serverRelayScopeUserId: 'user_1',
            serverRelaySocket: {
                socketId: relaySocketId,
                send: vi.fn((event, envelope) => {
                    sent.push({ event, envelope });
                }),
                onEnvelope: vi.fn((handler) => {
                    relayHandlers.add(handler);
                    return () => {
                        relayHandlers.delete(handler);
                    };
                }),
            },
        });

        expect(result).toMatchObject({ ok: true, routeKind: 'server_relay' });
        expect(sent).toMatchObject([{
            event: PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
            envelope: {
                v: 1,
                scopeUserId: 'user_1',
                sender: { kind: 'user', socketId: relaySocketId },
                frame: {
                    kind: 'open',
                    open: expect.objectContaining({ routeKind: 'server_relay' }),
                },
            },
        }]);
    });
});
