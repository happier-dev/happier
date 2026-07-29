import {
    PEER_TCP_TUNNEL_STREAM_PATH,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelOpenResponseV1,
    type PeerTcpTunnelOpenV1,
    type PeerTcpTunnelOpenV2,
} from '@happier-dev/protocol';

import type { PeerTcpTunnelClientStream } from './client';
import {
    decodePeerTcpTunnelFrameForEncoding,
    decodePeerTcpTunnelSubstreamFrameV2,
    encodePeerTcpTunnelFrameForEncoding,
    encodePeerTcpTunnelSubstreamDataFrameV2,
    encodePeerTcpTunnelSubstreamFrameV2,
    encodePeerTcpTunnelSubstreamOpenFrameV2,
} from './frameEncoding';

const DEFAULT_TUNNEL_WEBSOCKET_OPEN_TIMEOUT_MS = 30_000;

export type PeerTcpTunnelWebSocketLike = {
    binaryType?: string;
    onopen?: () => void;
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: unknown) => void;
    onclose?: () => void;
    send: (payload: string | Uint8Array) => void;
    close: () => void;
};

export type PeerTcpTunnelWebSocketCtor = new (url: string) => PeerTcpTunnelWebSocketLike;

function resolveLoopbackStreamUrl(endpointUrl: string, streamPath: string): string {
    const url = new URL(streamPath || PEER_TCP_TUNNEL_STREAM_PATH, endpointUrl);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    return url.toString();
}

function resolveWebSocketCtor(input?: PeerTcpTunnelWebSocketCtor): PeerTcpTunnelWebSocketCtor | null {
    if (input) return input;
    const candidate = (globalThis as unknown as { WebSocket?: PeerTcpTunnelWebSocketCtor }).WebSocket;
    return candidate ?? null;
}

export async function openPeerTcpTunnelLoopbackStream(input: Readonly<{
    endpointUrl: string;
    open: PeerTcpTunnelOpenV1 | PeerTcpTunnelOpenV2;
    response: PeerTcpTunnelOpenResponseV1;
    WebSocketCtor?: PeerTcpTunnelWebSocketCtor;
    openTimeoutMs?: number;
}>): Promise<PeerTcpTunnelClientStream> {
    const WebSocketCtor = resolveWebSocketCtor(input.WebSocketCtor);
    if (!WebSocketCtor) throw new Error('Peer TCP tunnel loopback websocket is unavailable');

    const socket = new WebSocketCtor(resolveLoopbackStreamUrl(input.endpointUrl, input.response.streamPath));
    socket.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Peer TCP tunnel loopback websocket open timed out'));
        }, Math.max(1, Math.floor(input.openTimeoutMs ?? DEFAULT_TUNNEL_WEBSOCKET_OPEN_TIMEOUT_MS)));
        socket.onopen = () => {
            clearTimeout(timeout);
            resolve();
        };
        socket.onerror = (event) => {
            clearTimeout(timeout);
            reject(event instanceof Error ? event : new Error('Peer TCP tunnel loopback websocket failed'));
        };
    });

    const handlers = new Set<(frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => void>();
    const substreamHandlers = new Set<(event: Readonly<{
        substreamId: string;
        frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
    }>) => void>();
    socket.onmessage = (event) => {
        const decodedSubstream = input.response.encoding === 'binary_frame_v2'
            ? decodePeerTcpTunnelSubstreamFrameV2({
                payload: event.data,
                maxFrameBytes: input.response.maxFrameBytes,
            })
            : null;
        if (decodedSubstream?.ok && decodedSubstream.frame.tunnelId === input.open.tunnelId) {
            for (const handler of substreamHandlers) handler({
                substreamId: decodedSubstream.substreamId,
                frame: decodedSubstream.frame,
            });
            return;
        }
        const decoded = decodePeerTcpTunnelFrameForEncoding({
            encoding: input.response.encoding,
            payload: event.data,
            maxFrameBytes: input.response.maxFrameBytes,
        });
        if (!decoded.ok || decoded.frame.tunnelId !== input.open.tunnelId) return;
        for (const handler of handlers) handler(decoded.frame);
    };

    return {
        sendFrame: (frame) => {
            socket.send(encodePeerTcpTunnelFrameForEncoding({
                encoding: input.response.encoding,
                frame,
            }));
        },
        onFrame: (handler) => {
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },
        sendSubstreamOpen: (substreamId) => {
            if (input.response.encoding !== 'binary_frame_v2') return;
            socket.send(encodePeerTcpTunnelSubstreamOpenFrameV2({
                tunnelId: input.open.tunnelId,
                substreamId,
            }));
        },
        sendSubstreamDataFrame: (substreamId, frame) => {
            if (input.response.encoding !== 'binary_frame_v2') return;
            socket.send(encodePeerTcpTunnelSubstreamDataFrameV2({
                substreamId,
                frame,
            }));
        },
        sendSubstreamFrame: (substreamId, frame) => {
            if (input.response.encoding !== 'binary_frame_v2') return;
            socket.send(encodePeerTcpTunnelSubstreamFrameV2({
                substreamId,
                frame,
            }));
        },
        onSubstreamFrame: (handler) => {
            substreamHandlers.add(handler);
            return () => {
                substreamHandlers.delete(handler);
            };
        },
        close: () => {
            socket.close();
        },
    };
}
