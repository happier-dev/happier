import {
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    PEER_TCP_TUNNEL_ENCODING_V1,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PEER_TCP_TUNNEL_STREAM_PATH,
    type FeatureDecision,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelOpenResponseV1,
    type PeerTcpTunnelOpenV1,
    type PeerTcpTunnelOpenV2,
    type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';

import {
    resolveTcpTunnelRouteDecision,
    type PeerTcpTunnelFlowKind,
} from '@happier-dev/peer-mediation';

import type { PeerLoopbackRouteAvailabilityResult } from '../loopback/resolvePeerLoopbackRouteAvailability';
import { openPeerTcpTunnelLoopbackStream, type PeerTcpTunnelWebSocketCtor } from './loopbackStream';
import { openPeerTcpTunnelRelayStream } from './relayStream';

export type OpenPeerTcpTunnelClientResult =
    | Readonly<{
        ok: true;
        routeKind: 'loopback_direct' | 'server_relay';
        response: PeerTcpTunnelOpenResponseV1;
        stream: PeerTcpTunnelClientStream;
      }>
    | Readonly<{
        ok: false;
        reasonCode: string;
        /**
         * Present when the direct route was attempted and failed with a reason outside this flow's
         * disabled-reason vocabulary (a loopback probe or grant-mint code).
         */
        directRouteReasonCode?: string;
      }>;

export type PeerTcpTunnelClientStream = Readonly<{
    sendFrame: (frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => Promise<void> | void;
    onFrame: (handler: (frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => void) => () => void;
    sendSubstreamOpen?: (substreamId: string) => Promise<void> | void;
    sendSubstreamDataFrame?: (
        substreamId: string,
        frame: Readonly<{
            tunnelId: string;
            direction: Extract<PeerTcpTunnelFrameV1, { kind: 'data' }>['direction'];
            sequence: number;
            payloadBytes: Uint8Array;
        }>,
    ) => Promise<void> | void;
    sendSubstreamFrame?: (
        substreamId: string,
        frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>,
    ) => Promise<void> | void;
    onSubstreamFrame?: (
        handler: (
            event: Readonly<{
                substreamId: string;
                frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
            }>,
        ) => void,
    ) => () => void;
    close: () => Promise<void> | void;
}>;

export type PeerTcpTunnelRelaySocketClient = Readonly<{
    socketId: string;
    send: (
        event: typeof PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
        envelope: PeerTcpTunnelRelayEnvelope,
    ) => void;
    onEnvelope: (handler: (envelope: PeerTcpTunnelRelayEnvelope) => void) => () => void;
}>;

type PeerTcpTunnelDirectOpen = PeerTcpTunnelOpenV1 | PeerTcpTunnelOpenV2;

export async function openPeerTcpTunnel(input: Readonly<{
    open: PeerTcpTunnelDirectOpen;
    /**
     * `tcp_tunnel` unless the caller is the voice-media transport, which rides the same tunnel but
     * is gated by its own feature bits (`resolvePeerRouteFeatureId`). Defaults to `tcp_tunnel`.
     */
    flowKind?: PeerTcpTunnelFlowKind;
    directPeerDecision: FeatureDecision | null | undefined;
    serverRoutedDecision: FeatureDecision | null | undefined;
    resolveLoopback: (request: Readonly<{
        flowKind: 'tcp_tunnel';
        routeKind: 'loopback_direct';
        targetMachineId: string;
    }>) => Promise<PeerLoopbackRouteAvailabilityResult>;
    postOpen: (request: Readonly<{
        open: PeerTcpTunnelDirectOpen;
    }>) => Promise<PeerTcpTunnelOpenResponseV1>;
    loopbackEndpointUrl?: string;
    WebSocketCtor?: PeerTcpTunnelWebSocketCtor;
    openStreamTimeoutMs?: number;
    signal?: AbortSignal | null;
    serverRelayScopeUserId?: string;
    serverRelaySocket?: PeerTcpTunnelRelaySocketClient;
    openLoopbackStream?: (request: Readonly<{
        open: PeerTcpTunnelDirectOpen;
        response: PeerTcpTunnelOpenResponseV1;
        signal: AbortSignal | null;
    }>) => Promise<PeerTcpTunnelClientStream>;
    openServerRelayStream?: (request: Readonly<{
        open: PeerTcpTunnelOpenV1;
        signal: AbortSignal | null;
    }>) => Promise<PeerTcpTunnelClientStream>;
}>): Promise<OpenPeerTcpTunnelClientResult> {
    const loopback = await input.resolveLoopback({
        flowKind: 'tcp_tunnel',
        routeKind: 'loopback_direct',
        targetMachineId: input.open.targetMachineId,
    });
    const route = resolveTcpTunnelRouteDecision({
        flowKind: input.flowKind ?? 'tcp_tunnel',
        directPeerDecision: input.directPeerDecision,
        serverRoutedDecision: input.serverRoutedDecision,
        directRoute: loopback.kind === 'selected'
            ? { status: 'selected' }
            : { status: 'unavailable', reasonCode: loopback.reasonCode },
    });
    if (route.kind !== 'selected') {
        return {
            ok: false,
            reasonCode: route.reasonCode,
            ...(route.directRouteReasonCode ? { directRouteReasonCode: route.directRouteReasonCode } : {}),
        };
    }

    if (route.routeKind === 'server_relay') {
        if (input.open.v === 2) return { ok: false, reasonCode: 'proof_version_route_mismatch' };
        const selectedOpen: PeerTcpTunnelOpenV1 = { ...input.open, routeKind: 'server_relay' };
        const relaySocket = input.serverRelaySocket;
        const relayScopeUserId = input.serverRelayScopeUserId;
        const openServerRelayStream = input.openServerRelayStream
            ?? (
                relayScopeUserId && relaySocket
                    ? (request: Readonly<{ open: PeerTcpTunnelOpenV1 }>) => openPeerTcpTunnelRelayStream({
                        scopeUserId: relayScopeUserId,
                        relaySocketId: relaySocket.socketId,
                        open: request.open,
                        send: relaySocket.send,
                        onEnvelope: relaySocket.onEnvelope,
                        signal: request.signal,
                    })
                    : null
            );
        if (!openServerRelayStream) {
            return {
                ok: false,
                reasonCode: 'stream_transport_unavailable',
            };
        }
        if (
            !relaySocket
            || relaySocket.socketId.length === 0
            || selectedOpen.relayAuthorization?.payload.v !== 2
            || selectedOpen.relayAuthorization.payload.relaySocketId !== relaySocket.socketId
        ) {
            return {
                ok: false,
                reasonCode: 'relay_socket_binding_mismatch',
            };
        }
        return {
            ok: true,
            routeKind: 'server_relay',
            response: {
                v: 1,
                tunnelId: selectedOpen.tunnelId,
                streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
                encoding: selectedOpen.selectedEncoding ?? PEER_TCP_TUNNEL_ENCODING_V1,
                initialWindowBytes: PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
                maxFrameBytes: selectedOpen.relayAuthorization?.payload.maxFrameBytes
                    ?? PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
            },
            stream: await openServerRelayStream({ open: selectedOpen, signal: input.signal ?? null }),
        };
    }

    const selectedOpen: PeerTcpTunnelDirectOpen = { ...input.open, routeKind: 'loopback_direct' };

    const loopbackEndpointUrl = input.loopbackEndpointUrl;
    const openLoopbackStream = input.openLoopbackStream
        ?? (
            loopbackEndpointUrl
                ? (request: Readonly<{
                    open: PeerTcpTunnelDirectOpen;
                    response: PeerTcpTunnelOpenResponseV1;
                }>) => openPeerTcpTunnelLoopbackStream({
                    endpointUrl: loopbackEndpointUrl,
                    open: request.open,
                    response: request.response,
                    WebSocketCtor: input.WebSocketCtor,
                    openTimeoutMs: input.openStreamTimeoutMs,
                    signal: request.signal,
                })
                : null
        );
    if (!openLoopbackStream) {
        return {
            ok: false,
            reasonCode: 'stream_transport_unavailable',
        };
    }
    const response = await input.postOpen({ open: selectedOpen });
    return {
        ok: true,
        routeKind: 'loopback_direct',
        response,
        stream: await openLoopbackStream({ open: selectedOpen, response, signal: input.signal ?? null }),
    };
}
