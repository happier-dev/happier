import { decodePeerTcpTunnelBinaryFrameV2, encodePeerTcpTunnelBinaryFrameV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, type PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import {
    createPeerTcpTunnelStreamSession,
    decodePeerTcpTunnelBinaryFrameForSubstreamSession,
    encodePeerTcpTunnelBinaryFrameForSubstream,
    encodePeerTcpTunnelBinaryFrameForSession,
} from "@happier-dev/peer-transport/duplexFrames";
import type { PeerTcpTunnelStreamSessionResult } from "@happier-dev/peer-transport/duplexFrames";

export type PeerTcpTunnelRelayTransport = Readonly<{
    relaySocketId: string;
    send(event: typeof PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope: PeerTcpTunnelRelayEnvelope): void;
    subscribe(handler: (envelope: PeerTcpTunnelRelayEnvelope) => void): () => void;
    close(): void;
}>;

export type PeerTcpTunnelRelayTransportFactory = (input: Readonly<{
    accountId: string;
}>) => PeerTcpTunnelRelayTransport;

type QueuedRead =
    | Readonly<{ kind: "chunk"; chunk: Uint8Array; onConsumed: () => void }>
    | Readonly<{ kind: "done" }>;

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
    private readonly items: QueuedRead[] = [];
    private readonly waiters: ((item: QueuedRead) => void)[] = [];
    private closed = false;
    private failure: Error | undefined;
    private readonly pendingConsumption = new Set<() => void>();

    push(chunk: Uint8Array): Promise<void> {
        if (this.closed) return Promise.resolve();
        return new Promise((resolve) => {
            const onConsumed = () => { this.pendingConsumption.delete(onConsumed); resolve(); };
            this.pendingConsumption.add(onConsumed);
            this.publish({ kind: "chunk", chunk, onConsumed });
        });
    }

    end(): void {
        if (this.closed) return;
        this.closed = true;
        this.publish({ kind: "done" });
    }

    close(error?: Error): void {
        this.failure ??= error;
        this.closed = true;
        this.items.splice(0);
        for (const consume of this.pendingConsumption) consume();
        for (const waiter of this.waiters.splice(0)) waiter({ kind: "done" });
    }

    private publish(item: QueuedRead): void {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter(item);
            return;
        }
        this.items.push(item);
    }

    private async nextItem(): Promise<QueuedRead> {
        if (this.failure) throw this.failure;
        const item = this.items.shift();
        if (item) return item;
        if (this.closed) return { kind: "done" };
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        while (true) {
            const item = await this.nextItem();
            if (this.failure) throw this.failure;
            if (item.kind === "chunk") {
                try { yield item.chunk; }
                finally { item.onConsumed(); }
                continue;
            }
            return;
        }
    }
}

export type PeerTcpTunnelRelayByteStream = Readonly<{
    tunnelId: string;
    substreamId?: string;
    write(chunk: Uint8Array): Promise<PeerTcpTunnelStreamSessionResult>;
    endWrite(): Promise<PeerTcpTunnelStreamSessionResult>;
    read(): AsyncIterable<Uint8Array>;
    close(): Promise<void>;
    abort(reasonCode: string): Promise<void>;
}>;

export type PeerTcpTunnelRelayStream = Readonly<{
    stream: PeerTcpTunnelRelayByteStream;
    open(): void;
    acceptEnvelope(envelope: PeerTcpTunnelRelayEnvelope): void;
    closeFromTunnel(reasonCode?: string): void;
    readTerminalReasonCode(): string | undefined;
}>;

function normalizeChunk(chunk: Uint8Array): Uint8Array {
    return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

/**
 * Owns binary V2 bytes for an already-authorized parent stream or child substream.
 * Target selection, route grants, authorization, reuse, and lifecycle remain with the caller.
 */
export function createPeerTcpTunnelRelayStream(input: Readonly<{
    tunnelId: string;
    substreamId?: string;
    initialWindowBytes: number;
    maxFrameBytes: number;
    maxDecodedPayloadBytes: number;
    maxSendChunkBytes: number;
    sendEncodedBinaryFrame(frame: Uint8Array): void;
    onRelease(): void;
}>): PeerTcpTunnelRelayStream {
    const queue = new AsyncByteQueue();
    let closed = false;
    let terminalError: Error | undefined;

    function release(): void {
        if (closed) return;
        closed = true;
        queue.end();
        input.onRelease();
    }

    const frameSession = createPeerTcpTunnelStreamSession({
        tunnelId: input.tunnelId,
        outboundDirection: "client_to_daemon",
        initialWindowBytes: input.initialWindowBytes,
        maxFrameBytes: input.maxFrameBytes,
        maxDecodedPayloadBytes: input.maxDecodedPayloadBytes,
        maxSendChunkBytes: input.maxSendChunkBytes,
        ackAfterBytes: 1,
        connection: {
            write: (bytes) => queue.push(bytes),
            endWrite: () => queue.end(),
            close: () => release(),
        },
        sendFrame: (frame) => {
            input.sendEncodedBinaryFrame(input.substreamId === undefined
                ? encodePeerTcpTunnelBinaryFrameForSession(frame)
                : encodePeerTcpTunnelBinaryFrameForSubstream({ frame, substreamId: input.substreamId }));
        },
    });

    const stream: PeerTcpTunnelRelayByteStream = {
        tunnelId: input.tunnelId,
        substreamId: input.substreamId,
        write: (chunk) => frameSession.write(normalizeChunk(chunk)),
        endWrite: () => frameSession.endWrite("client_write_complete"),
        read: () => queue,
        close: () => {
            queue.close();
            return frameSession.terminate("client_stream_closed");
        },
        abort: (reasonCode) => {
            queue.close(new Error(reasonCode || "client_stream_aborted"));
            return frameSession.abort(reasonCode || "client_stream_aborted");
        },
    };

    return {
        stream,
        readTerminalReasonCode: () => terminalError?.message,
        open() {
            // Parent admission is the signed V1 open, owned by the caller.
            if (input.substreamId === undefined) return;
            input.sendEncodedBinaryFrame(encodePeerTcpTunnelBinaryFrameV2({
                header: {
                    version: 2,
                    kind: "open",
                    tunnelId: input.tunnelId,
                    substreamId: input.substreamId,
                    payloadLength: 0,
                },
            }));
        },
        acceptEnvelope(envelope) {
            if (closed || envelope.v !== 2 || envelope.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) return;
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: input.maxFrameBytes,
                maxPayloadBytes: input.maxDecodedPayloadBytes,
            });
            if (!decoded.ok || decoded.header.tunnelId !== input.tunnelId || decoded.header.substreamId !== input.substreamId) {
                return;
            }
            const frame = decodePeerTcpTunnelBinaryFrameForSubstreamSession({
                header: decoded.header,
                payload: decoded.payload,
            });
            if (!frame) return;
            if (frame.kind === "abort") {
                terminalError ??= Object.assign(new Error(frame.reasonCode), { reasonCode: frame.reasonCode });
                queue.close(terminalError);
            }
            void frameSession.acceptFrame(frame).catch((error) => {
                queue.close(error instanceof Error ? error : new Error(String(error)));
                release();
            });
        },
        closeFromTunnel(reasonCode = "tunnel_closed") {
            terminalError ??= Object.assign(new Error(reasonCode), { reasonCode });
            queue.close(terminalError);
            // The parent transport is already gone, so close only the local
            // frame session. It owns pending credit-blocked write settlement,
            // timers, queue teardown, and the exact connection release.
            void frameSession.close().catch(() => undefined);
        },
    };
}
