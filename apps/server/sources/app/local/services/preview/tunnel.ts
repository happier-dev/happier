import { randomUUID } from "node:crypto";

import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    type LocalServicePreviewResourceV1,
    type PeerTcpTunnelBinaryFrameHeaderV2,
    type PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";

import { readMachineTunnelFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolvePeerMediationGrantSigningConfig } from "@/app/machines/peer/mediation/mintDirectRouteGrantV1";
import { mintPeerTcpTunnelRelayAuthorizationV1 } from "@/app/machines/peer/mediation/tunnel";
import type {
    LocalServicePreviewTunnelStream,
    OpenLocalServicePreviewTunnel,
} from "@/app/local/services/preview/httpAdapter";

export type PeerTcpTunnelRelayTransport = Readonly<{
    send(event: typeof PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope: PeerTcpTunnelRelayEnvelope): void;
    subscribe(handler: (envelope: PeerTcpTunnelRelayEnvelope) => void): () => void;
    close(): void;
}>;

export type PeerTcpTunnelRelayTransportFactory = (input: Readonly<{
    accountId: string;
}>) => PeerTcpTunnelRelayTransport;

export type CreateLocalServicePreviewTunnelOpenerInput = Readonly<{
    env: NodeJS.ProcessEnv;
    resolvePreviewAccountId(previewId: string): string | null | undefined;
    createRelayTransport: PeerTcpTunnelRelayTransportFactory;
    nowMs?: () => number;
    generateId?: () => string;
}>;

type PreviewTunnelSession = {
    accountId: string;
    preview: LocalServicePreviewResourceV1;
    tunnelId: string;
    transport: PeerTcpTunnelRelayTransport;
    unsubscribe: () => void;
    activeStreams: number;
    closed: boolean;
    streams: Map<string, PreviewSubstream>;
    idleCloseTimer: ReturnType<typeof setTimeout> | null;
};

type PreviewSubstream = {
    substreamId: string;
    enqueueEnvelope(envelope: PeerTcpTunnelRelayEnvelope): void;
    closeFromSession(): void;
};

type QueuedRead =
    | Readonly<{ kind: "chunk"; chunk: Uint8Array }>
    | Readonly<{ kind: "done" }>
    | Readonly<{ kind: "error"; error: unknown }>;

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
    private readonly items: QueuedRead[] = [];
    private readonly waiters: ((item: QueuedRead) => void)[] = [];
    private closed = false;

    push(chunk: Uint8Array): void {
        if (this.closed) return;
        this.publish({ kind: "chunk", chunk });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.publish({ kind: "done" });
    }

    fail(error: unknown): void {
        if (this.closed) return;
        this.closed = true;
        this.publish({ kind: "error", error });
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
        const item = this.items.shift();
        if (item) return item;
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        while (true) {
            const item = await this.nextItem();
            if (item.kind === "chunk") {
                yield item.chunk;
                continue;
            }
            if (item.kind === "error") {
                throw item.error;
            }
            return;
        }
    }
}

function normalizeAccountId(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeChunk(chunk: Uint8Array): Uint8Array {
    return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

function createTunnelUnavailableError(reasonCode: string): Error {
    return new Error(`local_service_preview_tunnel_unavailable:${reasonCode}`);
}

export function createLocalServicePreviewTunnelOpener(
    input: CreateLocalServicePreviewTunnelOpenerInput,
): OpenLocalServicePreviewTunnel {
    const nowMs = input.nowMs ?? Date.now;
    const generateId = input.generateId ?? randomUUID;
    const sessions = new Map<string, PreviewTunnelSession>();

    function sessionKey(accountId: string, preview: LocalServicePreviewResourceV1): string {
        return [
            accountId,
            preview.machineId,
            preview.target.scheme,
            preview.target.host,
            preview.target.port,
        ].join(":");
    }

    function sendEnvelope(session: PreviewTunnelSession, envelope: PeerTcpTunnelRelayEnvelope): void {
        session.transport.send(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);
    }

    function sendBinaryFrame(
        session: PreviewTunnelSession,
        header: PeerTcpTunnelBinaryFrameHeaderV2,
        payload?: Uint8Array,
    ): void {
        sendEnvelope(session, {
            v: 2,
            scopeUserId: session.accountId,
            sender: { kind: "user" },
            recipient: { kind: "machine", machineId: session.preview.machineId },
            encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            frame: encodePeerTcpTunnelBinaryFrameV2({ header, payload }),
        });
    }

    function clearSessionIdleClose(session: PreviewTunnelSession): void {
        if (!session.idleCloseTimer) return;
        clearTimeout(session.idleCloseTimer);
        session.idleCloseTimer = null;
    }

    function closeSession(key: string, session: PreviewTunnelSession): void {
        if (session.closed) return;
        session.closed = true;
        clearSessionIdleClose(session);
        for (const stream of session.streams.values()) stream.closeFromSession();
        session.streams.clear();
        sendBinaryFrame(session, {
            version: 2,
            kind: "close",
            tunnelId: session.tunnelId,
            halfClose: false,
            reasonCode: "preview_tunnel_closed",
            payloadLength: 0,
        });
        session.unsubscribe();
        session.transport.close();
        sessions.delete(key);
    }

    function scheduleSessionIdleClose(key: string, session: PreviewTunnelSession, idleDelayMs: number): void {
        if (session.closed || session.activeStreams > 0) return;
        clearSessionIdleClose(session);
        session.idleCloseTimer = setTimeout(() => {
            closeSession(key, session);
        }, Math.max(1, idleDelayMs));
        session.idleCloseTimer.unref?.();
    }

    function getOrCreateSession(accountId: string, preview: LocalServicePreviewResourceV1): PreviewTunnelSession {
        const key = sessionKey(accountId, preview);
        const existing = sessions.get(key);
        if (existing && !existing.closed) {
            clearSessionIdleClose(existing);
            return existing;
        }

        const featureEnv = readMachineTunnelFeatureEnv(input.env);
        const signing = resolvePeerMediationGrantSigningConfig(input.env);
        if (!signing.ok) {
            throw createTunnelUnavailableError("grant_signing_unavailable");
        }

        const tunnelId = `preview_tunnel_${generateId()}`;
        const authorization = mintPeerTcpTunnelRelayAuthorizationV1({
            accountId,
            targetMachineId: preview.machineId,
            destination: {
                host: preview.target.host,
                port: preview.target.port,
            },
            scope: {
                kind: "tcp_tunnel",
                tunnelId,
                allowedPorts: [preview.target.port],
                maxIdleMs: featureEnv.maxIdleMs,
                maxDurationMs: featureEnv.maxDurationMs,
                maxTotalBytes: featureEnv.serverRoutedMaxBytes,
            },
            nowMs: nowMs(),
            ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.serverRelayedTcpTunnel,
            serverGateEnabled: featureEnv.serverRoutedEnabled,
            serverCaps: {
                allowedPorts: featureEnv.allowedPorts,
                maxBytes: featureEnv.serverRoutedMaxBytes,
                maxFrameBytes: featureEnv.serverRoutedMaxFrameBytes,
                maxIdleMs: featureEnv.maxIdleMs,
                maxDurationMs: featureEnv.maxDurationMs,
            },
            signingKey: {
                keyId: signing.keyId,
                secretKey: signing.secretKey,
            },
        });
        if (!authorization.ok) {
            throw createTunnelUnavailableError(authorization.reasonCode);
        }

        const transport = input.createRelayTransport({ accountId });
        const session: PreviewTunnelSession = {
            accountId,
            preview,
            tunnelId,
            transport,
            unsubscribe: () => undefined,
            activeStreams: 0,
            closed: false,
            streams: new Map(),
            idleCloseTimer: null,
        };
        session.unsubscribe = transport.subscribe((envelope) => {
            if (envelope.scopeUserId !== accountId) return;
            if (envelope.sender.kind !== "machine" || envelope.sender.machineId !== preview.machineId) return;
            if (envelope.recipient.kind !== "user") return;
            if (envelope.v === 1) {
                const tunnelIdFromFrame = envelope.frame.kind === "open" ? envelope.frame.open.tunnelId : envelope.frame.tunnelId;
                if (tunnelIdFromFrame === session.tunnelId && envelope.frame.kind === "abort") {
                    closeSession(key, session);
                }
                return;
            }
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: featureEnv.serverRoutedMaxBinaryHeaderBytes,
                maxPayloadBytes: featureEnv.serverRoutedMaxRawPayloadBytes,
            });
            if (!decoded.ok || decoded.header.tunnelId !== session.tunnelId) return;
            const substreamId = decoded.header.substreamId;
            if (!substreamId) {
                if (decoded.header.kind === "close" || decoded.header.kind === "abort") {
                    closeSession(key, session);
                }
                return;
            }
            session.streams.get(substreamId)?.enqueueEnvelope(envelope);
        });

        sendEnvelope(session, {
            v: 1,
            scopeUserId: accountId,
            sender: { kind: "user" },
            recipient: { kind: "machine", machineId: preview.machineId },
            frame: {
                v: 1,
                kind: "open",
                open: {
                    v: 1,
                    kind: "open",
                    tunnelId,
                    targetMachineId: preview.machineId,
                    routeKind: "server_relay",
                    destination: {
                        host: preview.target.host,
                        port: preview.target.port,
                    },
                    relayAuthorization: authorization.relayAuthorization,
                    supportedEncodings: [PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2],
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    allowV1Fallback: false,
                },
            },
        });

        sessions.set(key, session);
        return session;
    }

    return async ({ preview }) => {
        const accountId = normalizeAccountId(input.resolvePreviewAccountId(preview.previewId));
        if (!accountId) {
            throw createTunnelUnavailableError("preview_account_missing");
        }

        const key = sessionKey(accountId, preview);
        const session = getOrCreateSession(accountId, preview);
        const featureEnv = readMachineTunnelFeatureEnv(input.env);
        const substreamId = `preview_substream_${generateId()}`;
        const queue = new AsyncByteQueue();
        let clientSequence = 0;
        let daemonSequence = 0;
        let clientAckedSequence = 0;
        let clientWindowBytes = PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES;
        let closed = false;
        let waitForClientCredit: (() => void) | null = null;

        function availableClientWindow(): number {
            return Math.max(0, clientAckedSequence + clientWindowBytes - clientSequence);
        }

        function wakeClientCreditWaiter(): void {
            const waiter = waitForClientCredit;
            waitForClientCredit = null;
            waiter?.();
        }

        async function waitForClientWindow(): Promise<void> {
            if (availableClientWindow() > 0 || closed) return;
            await new Promise<void>((resolve) => {
                waitForClientCredit = resolve;
            });
        }

        function releaseStream(): void {
            if (closed) return;
            closed = true;
            queue.close();
            session.streams.delete(substreamId);
            session.activeStreams = Math.max(0, session.activeStreams - 1);
            wakeClientCreditWaiter();
            if (session.activeStreams === 0) {
                scheduleSessionIdleClose(key, session, featureEnv.maxIdleMs);
            }
        }

        const stream: PreviewSubstream = {
            substreamId,
            enqueueEnvelope(envelope) {
                if (closed || envelope.v !== 2) return;
                const decoded = decodePeerTcpTunnelBinaryFrameV2({
                    frame: envelope.frame,
                    maxHeaderBytes: featureEnv.serverRoutedMaxBinaryHeaderBytes,
                    maxPayloadBytes: featureEnv.serverRoutedMaxRawPayloadBytes,
                });
                if (!decoded.ok || decoded.header.tunnelId !== session.tunnelId || decoded.header.substreamId !== substreamId) {
                    return;
                }
                if (decoded.header.kind === "ack" && decoded.header.direction === "client_to_daemon") {
                    clientAckedSequence = decoded.header.ack ?? clientAckedSequence;
                    clientWindowBytes = decoded.header.window ?? clientWindowBytes;
                    wakeClientCreditWaiter();
                    return;
                }
                if (decoded.header.kind === "data" && decoded.header.direction === "daemon_to_client") {
                    if (decoded.header.sequence !== daemonSequence) {
                        queue.fail(createTunnelUnavailableError("sequence_mismatch"));
                        releaseStream();
                        return;
                    }
                    daemonSequence += decoded.payload.byteLength;
                    queue.push(decoded.payload);
                    sendBinaryFrame(session, {
                        version: 2,
                        kind: "ack",
                        tunnelId: session.tunnelId,
                        substreamId,
                        direction: "daemon_to_client",
                        ack: daemonSequence,
                        window: PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
                        payloadLength: 0,
                    });
                    return;
                }
                if (decoded.header.kind === "close" || decoded.header.kind === "abort") {
                    releaseStream();
                }
            },
            closeFromSession() {
                if (closed) return;
                closed = true;
                queue.close();
                wakeClientCreditWaiter();
            },
        };

        session.streams.set(substreamId, stream);
        session.activeStreams += 1;
        sendBinaryFrame(session, {
            version: 2,
            kind: "open",
            tunnelId: session.tunnelId,
            substreamId,
            payloadLength: 0,
        });

        async function sendClientData(chunk: Uint8Array): Promise<void> {
            for (let offset = 0; offset < chunk.byteLength;) {
                await waitForClientWindow();
                if (closed) return;
                const available = Math.max(1, availableClientWindow());
                const length = Math.min(
                    chunk.byteLength - offset,
                    available,
                    featureEnv.serverRoutedMaxRawPayloadBytes,
                );
                const payload = chunk.subarray(offset, offset + length);
                sendBinaryFrame(session, {
                    version: 2,
                    kind: "data",
                    tunnelId: session.tunnelId,
                    substreamId,
                    direction: "client_to_daemon",
                    sequence: clientSequence,
                    payloadLength: payload.byteLength,
                }, payload);
                clientSequence += payload.byteLength;
                offset += payload.byteLength;
            }
        }

        const tunnelStream: LocalServicePreviewTunnelStream = {
            write: async (chunk) => {
                await sendClientData(normalizeChunk(chunk));
            },
            endWrite: () => {
                if (closed) return;
                sendBinaryFrame(session, {
                    version: 2,
                    kind: "close",
                    tunnelId: session.tunnelId,
                    substreamId,
                    direction: "client_to_daemon",
                    halfClose: true,
                    reasonCode: "client_write_complete",
                    payloadLength: 0,
                });
            },
            read: () => queue,
            close: () => {
                if (closed) return;
                sendBinaryFrame(session, {
                    version: 2,
                    kind: "close",
                    tunnelId: session.tunnelId,
                    substreamId,
                    halfClose: false,
                    reasonCode: "client_stream_closed",
                    payloadLength: 0,
                });
                releaseStream();
            },
            abort: (reasonCode) => {
                if (closed) return;
                sendBinaryFrame(session, {
                    version: 2,
                    kind: "abort",
                    tunnelId: session.tunnelId,
                    substreamId,
                    reasonCode: reasonCode || "client_stream_aborted",
                    payloadLength: 0,
                });
                releaseStream();
            },
        };

        return tunnelStream;
    };
}

export function createUnavailableLocalServicePreviewTunnelOpener(reasonCode: string): OpenLocalServicePreviewTunnel {
    return async () => {
        throw createTunnelUnavailableError(reasonCode);
    };
}
