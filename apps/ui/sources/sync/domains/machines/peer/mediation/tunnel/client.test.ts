import { describe, expect, it, vi } from 'vitest';
import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    createFeatureDecision,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';

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

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];

    binaryType?: string;
    onopen?: () => void;
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: unknown) => void;
    onclose?: () => void;
    sent: Array<string | Uint8Array> = [];
    closed = false;

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => {
            this.onopen?.();
        });
    }

    send(payload: string | Uint8Array): void {
        this.sent.push(payload);
    }

    close(): void {
        this.closed = true;
        this.onclose?.();
    }
}

describe('openPeerTcpTunnel', () => {
    it('exports production stream adapters from the tunnel entrypoint', async () => {
        const mod = await import('./index');

        expect(mod.openPeerTcpTunnelLoopbackStream).toBeTypeOf('function');
        expect(mod.openPeerTcpTunnelRelayStream).toBeTypeOf('function');
    });

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

    it('opens the production loopback websocket adapter when endpoint dependencies are provided', async () => {
        const mod = await loadClientModule();
        const postOpen = vi.fn(async () => ({
            v: 1,
            tunnelId: 'tun_1',
            streamPath: '/peer-mediation/v1/tunnel/stream',
            encoding: 'json_base64_v1',
            initialWindowBytes: 1024 * 1024,
            maxFrameBytes: 64 * 1024,
        } as const));
        FakeWebSocket.instances = [];
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        const result = await mod?.openPeerTcpTunnel({
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
            loopbackEndpointUrl: 'http://127.0.0.1:19364',
            WebSocketCtor: FakeWebSocket,
        });

        expect(result).toMatchObject({ ok: true, routeKind: 'loopback_direct' });
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:19364/peer-mediation/v1/tunnel/stream');
    });

    it('opens the production server relay adapter when relay socket dependencies are provided', async () => {
        const mod = await loadClientModule();
        const sent: unknown[] = [];
        const relayHandlers = new Set<(envelope: unknown) => void>();
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        const result = await mod?.openPeerTcpTunnel({
            open,
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
                frame: {
                    kind: 'open',
                    open: expect.objectContaining({ routeKind: 'server_relay' }),
                },
            },
        }]);
    });

    it('reports the negotiated server relay encoding in the client response', async () => {
        const mod = await loadClientModule();
        expect(mod?.openPeerTcpTunnel).toBeTypeOf('function');

        const result = await mod?.openPeerTcpTunnel({
            open: {
                ...open,
                selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
            directPeerDecision: featureDecision('machines.tunnel.directPeer', true),
            serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
            resolveLoopback: vi.fn(async () => ({
                kind: 'fallback' as const,
                receipt: 'peer.route.fallback' as const,
                reasonCode: 'route_unavailable',
            })),
            postOpen: vi.fn(),
            openServerRelayStream: vi.fn(async () => ({ close: vi.fn(), sendFrame: vi.fn(), onFrame: vi.fn() })),
        });

        expect(result).toMatchObject({
            ok: true,
            routeKind: 'server_relay',
            response: {
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            },
        });
    });
});
