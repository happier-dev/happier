import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2} from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import {
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT} from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import {
    createFeatureDecision} from '@happier-dev/protocol/features/decision';
import {
    createEphemeralPeerRouteProofHandleV2} from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';
import {
    createDirectRouteGrantSigningInputV2,
    type DirectRouteGrantPayloadV2} from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { getStorage } from '@/sync/domains/state/storageStore';

const nativeBoundary = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@happier-dev/iroh-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/iroh-native')>(),
    getOptionalHappierIrohNativeModule: () => nativeBoundary.current,
}));

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
    it.each(['disabled_direct_policy', 'standard_only'] as const)('keeps the supported relay usable without minting native authority under %s', async (policy) => {
        const mod = await loadModule('./client');
        const openTunnel = mod.openPeerTcpTunnel;
        if (typeof openTunnel !== 'function') throw new Error('canonical tunnel client missing');
        const store = getStorage();
        const previous = store.getState().localSettings;
        store.setState({ localSettings: { ...previous, homeApplicationCarrierEligibility: policy === 'standard_only' ? 'standard_only' : 'automatic' } });
        const stream = { close: () => undefined, sendFrame: () => undefined, onFrame: () => () => undefined };
        try {
            await expect(openTunnel({
                open: relayOpen,
                directPeerDecision: featureDecision('machines.tunnel.directPeer', policy !== 'disabled_direct_policy'),
                serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
                resolveLoopback: async () => ({ kind: 'fallback', receipt: 'peer.route.fallback', reasonCode: 'route_unavailable' }),
                resolveIroh: async () => { throw new Error('native grant mint forbidden by the existing policy'); },
                postOpen: async () => { throw new Error('direct open forbidden'); },
                openServerRelayStream: async () => stream,
                serverRelaySocket: { socketId: relaySocketId, send: () => undefined, onEnvelope: () => () => undefined },
            })).resolves.toMatchObject({ ok: true, routeKind: 'server_relay' });
        } finally {
            store.setState({ localSettings: previous });
        }
    });

    it('selects the generic native carrier with a separately signed scope and retires its lease on cancellation', async () => {
        const mod = await loadModule('./client');
        const openTunnel = mod.openPeerTcpTunnel;
        if (typeof openTunnel !== 'function') throw new Error('canonical tunnel client missing');
        const handle = createEphemeralPeerRouteProofHandleV2({ randomBytes: (length) => new Uint8Array(length).fill(4) });
        const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const payload: DirectRouteGrantPayloadV2 = {
            v: 2, grantId: 'native-grant', accountId: 'user_1', machineId: 'machine_1', flowKind: 'tcp_tunnel', routeKind: 'iroh_peer',
            scope: { kind: 'tcp_tunnel', tunnelId: 'tun_1', allowedPorts: [3000] },
            iat: 1000, exp: 301000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'b'.repeat(64),
            iroh: { initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, target: { machineId: 'machine_1', endpointId: 'b'.repeat(64) }, operationKind: 'tcp_tunnel' },
            proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: handle.publicKeyBase64Url,
        };
        const grant = { payload, signature: { keyId: 'test-key', alg: 'Ed25519' as const, valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), signingKey.secretKey)).toString('base64url') } };
        const nativeOpen = { ...open, v: 2 as const, routeKind: 'iroh_peer' as const, grant, proof: handle.sign(grant) };
        const stopped: string[] = [];
        const capability = 'c'.repeat(64);
        const sent: unknown[] = [];
        const sockets: { onopen?: () => void; onclose?: () => void; url: string; protocols?: string | string[] }[] = [];
        class WebSocketBoundary {
            onopen?: () => void;
            onclose?: () => void;
            constructor(readonly url: string, readonly protocols?: string | string[]) {
                sockets.push(this);
                queueMicrotask(() => this.onopen?.());
            }
            send(bytes: unknown) { sent.push(bytes); }
            close() { this.onclose?.(); }
        }
        // Native SDK, HTTP and WebSocket are genuine system boundaries. The
        // route fold, shared endpoint owner, lease custody and codec are real.
        nativeBoundary.current = {
            getAvailability: () => ({ available: true }),
            createEndpoint: async () => ({ endpointHandle: 'client-endpoint', endpointId: 'a'.repeat(64), relayPolicy: 'automatic', relayMode: 'disabled', relayUrls: [], capProfile: 'machineBulk' }),
            startMachineTunnel: async () => { throw new Error('raw listener bypass'); },
            startMachineHttpTunnel: async () => ({ machineTunnelId: 'native-tcp', localPort: 48127, localCapability: capability }),
            stopMachineTunnel: async (leaseId: string) => { stopped.push(leaseId); },
        };
        const requests: { url: string; init?: RequestInit }[] = [];
        setRuntimeFetch(async (url, init) => {
            requests.push({ url: String(url), init });
            return new Response(JSON.stringify({ v: 1, tunnelId: 'tun_1', streamPath: '/peer-mediation/v1/tunnel/stream', encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2, initialWindowBytes: PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES, maxFrameBytes: PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES }), { status: 200 });
        });
        const cancellation = new AbortController();
        try {
            const result = await openTunnel({
                open: relayOpen, directPeerDecision: featureDecision('machines.tunnel.directPeer', true), serverRoutedDecision: featureDecision('machines.tunnel.serverRouted', true),
                resolveLoopback: async () => ({ kind: 'fallback', receipt: 'peer.route.fallback', reasonCode: 'route_unavailable' }),
                resolveIroh: async () => ({ kind: 'selected', open: nativeOpen, endpoint: { endpointId: 'b'.repeat(64), directAddresses: ['127.0.0.1:48128'] } }),
                postOpen: async () => { throw new Error('loopback control bypass'); },
                WebSocketCtor: WebSocketBoundary, signal: cancellation.signal,
            });
            expect(result).toMatchObject({ ok: true, routeKind: 'iroh_peer' });
            if (!result.ok) return;
            expect(requests[0]?.url).toBe('http://127.0.0.1:48127/peer-mediation/v2/tunnel/open');
            expect(new Headers(requests[0]?.init?.headers).get('x-happier-machine-local-capability')).toBe(capability);
            expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(nativeOpen);
            expect(sockets[0]?.protocols).toEqual([`happier.iroh.cap.${capability}`]);
            expect(sockets[0]?.url).not.toContain(capability);
            await result.stream.sendSubstreamDataFrame('request-1', { tunnelId: 'tun_1', direction: 'client_to_daemon', sequence: 0, payloadBytes: new Uint8Array([0, 255]) });
            expect(sent[0]).toBeInstanceOf(Uint8Array);
            cancellation.abort();
            await result.stream.close();
            expect(stopped).toEqual(['native-tcp']);
        } finally {
            resetRuntimeFetch();
            nativeBoundary.current = null;
            handle.dispose();
        }
    });
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
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
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
                encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
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
            signal: null,
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
