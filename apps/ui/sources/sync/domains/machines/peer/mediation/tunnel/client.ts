import {
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    PEER_TCP_TUNNEL_ENCODING_V1,
    PEER_TCP_TUNNEL_STREAM_PATH,
    type FeatureDecision,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelOpenResponseV1,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';

import type { PeerLoopbackRouteAvailabilityResult } from '../loopback/resolvePeerLoopbackRouteAvailability';
import { resolvePeerTcpTunnelAvailability } from './availability';

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
      }>;

export type PeerTcpTunnelClientStream = Readonly<{
    sendFrame: (frame: PeerTcpTunnelFrameV1) => Promise<void> | void;
    onFrame: (handler: (frame: PeerTcpTunnelFrameV1) => void) => () => void;
    close: () => Promise<void> | void;
}>;

export async function openPeerTcpTunnel(input: Readonly<{
    open: PeerTcpTunnelOpenV1;
    directPeerDecision: FeatureDecision | null | undefined;
    serverRoutedDecision: FeatureDecision | null | undefined;
    resolveLoopback: (request: Readonly<{
        flowKind: 'tcp_tunnel';
        routeKind: 'loopback_direct';
        targetMachineId: string;
    }>) => Promise<PeerLoopbackRouteAvailabilityResult>;
    postOpen: (request: Readonly<{
        open: PeerTcpTunnelOpenV1;
    }>) => Promise<PeerTcpTunnelOpenResponseV1>;
    openLoopbackStream?: (request: Readonly<{
        open: PeerTcpTunnelOpenV1;
        response: PeerTcpTunnelOpenResponseV1;
    }>) => Promise<PeerTcpTunnelClientStream>;
    openServerRelayStream?: (request: Readonly<{
        open: PeerTcpTunnelOpenV1;
    }>) => Promise<PeerTcpTunnelClientStream>;
}>): Promise<OpenPeerTcpTunnelClientResult> {
    const loopback = await input.resolveLoopback({
        flowKind: 'tcp_tunnel',
        routeKind: 'loopback_direct',
        targetMachineId: input.open.targetMachineId,
    });
    const availability = resolvePeerTcpTunnelAvailability({
        directPeerDecision: input.directPeerDecision,
        serverRoutedDecision: input.serverRoutedDecision,
        loopback,
    });
    if (availability.kind !== 'available') {
        return {
            ok: false,
            reasonCode: availability.reasonCode,
        };
    }

    const selectedOpen: PeerTcpTunnelOpenV1 = {
        ...input.open,
        routeKind: availability.routeKind,
    };

    if (availability.routeKind === 'server_relay') {
        if (!input.openServerRelayStream) {
            return {
                ok: false,
                reasonCode: 'stream_transport_unavailable',
            };
        }
        return {
            ok: true,
            routeKind: 'server_relay',
            response: {
                v: 1,
                tunnelId: selectedOpen.tunnelId,
                streamPath: PEER_TCP_TUNNEL_STREAM_PATH,
                encoding: PEER_TCP_TUNNEL_ENCODING_V1,
                initialWindowBytes: PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
                maxFrameBytes: PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
            },
            stream: await input.openServerRelayStream({ open: selectedOpen }),
        };
    }

    if (!input.openLoopbackStream) {
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
        stream: await input.openLoopbackStream({ open: selectedOpen, response }),
    };
}
