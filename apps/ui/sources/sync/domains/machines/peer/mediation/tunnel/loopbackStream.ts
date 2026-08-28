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
    signal?: AbortSignal | null;
}>): Promise<PeerTcpTunnelClientStream> {
    const WebSocketCtor = resolveWebSocketCtor(input.WebSocketCtor);
    if (!WebSocketCtor) throw new Error('Peer TCP tunnel loopback websocket is unavailable');

    const socket = new WebSocketCtor(resolveLoopbackStreamUrl(input.endpointUrl, input.response.streamPath));
    socket.binaryType = 'arraybuffer';

    const handlers = new Set<(frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>) => void>();
    const substreamHandlers = new Set<(event: Readonly<{
        substreamId: string;
        frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
    }>) => void>();
    let closed = false;
    let openSettled = false;
    let openTimeout: ReturnType<typeof setTimeout> | null = null;
    let rejectOpen: ((error: Error) => void) | null = null;

    const clearOpenWait = (): void => {
        if (openTimeout) {
            clearTimeout(openTimeout);
            openTimeout = null;
        }
        socket.onopen = undefined;
    };
    const detachLifetime = (): void => {
        input.signal?.removeEventListener('abort', abort);
        socket.onopen = undefined;
        socket.onmessage = undefined;
        socket.onerror = undefined;
        socket.onclose = undefined;
        handlers.clear();
        substreamHandlers.clear();
    };
    const retire = (closeTransport: boolean): void => {
        if (closed) return;
        closed = true;
        clearOpenWait();
        detachLifetime();
        if (closeTransport) {
            try {
                socket.close();
            } catch {
                // The stream is already retired. A transport-specific close failure cannot restore it.
            }
        }
    };
    const close = (): void => retire(true);
    const failOpen = (error: Error): void => {
        if (openSettled) {
            close();
            return;
        }
        openSettled = true;
        const reject = rejectOpen;
        rejectOpen = null;
        close();
        reject?.(error);
    };
    function abort(): void {
        const error = Object.assign(new Error('Peer TCP tunnel loopback websocket open aborted'), {
            name: 'AbortError',
        });
        if (!openSettled) {
            failOpen(error);
            return;
        }
        close();
    }

    await new Promise<void>((resolve, reject) => {
        rejectOpen = reject;
        openTimeout = setTimeout(() => {
            failOpen(new Error('Peer TCP tunnel loopback websocket open timed out'));
        }, Math.max(1, Math.floor(input.openTimeoutMs ?? DEFAULT_TUNNEL_WEBSOCKET_OPEN_TIMEOUT_MS)));
        socket.onopen = () => {
            if (openSettled || closed) return;
            openSettled = true;
            rejectOpen = null;
            clearOpenWait();
            resolve();
        };
        socket.onerror = (event) => {
            failOpen(event instanceof Error ? event : new Error('Peer TCP tunnel loopback websocket failed'));
        };
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
    });

    // Abort may win after `onopen` resolves but before this async continuation
    // resumes. Do not reattach handlers or publish an already-retired stream.
    if (closed || input.signal?.aborted) {
        close();
        throw Object.assign(new Error('Peer TCP tunnel loopback websocket open aborted'), {
            name: 'AbortError',
        });
    }

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
    socket.onerror = () => close();
    socket.onclose = () => retire(false);

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
            close();
        },
    };
}
