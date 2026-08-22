import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';

import {
    DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
    decodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_OPEN_PATH,
    PEER_TCP_TUNNEL_OPEN_PATH_V2,
    PEER_TCP_TUNNEL_STREAM_PATH,
    PeerTcpTunnelOpenV1Schema,
    PeerTcpTunnelOpenV2Schema,
    type VoiceMediaApplicationAuthorityV1,
} from '@happier-dev/protocol';

import { openPeerTcpTunnel, type OpenPeerTcpTunnelInput, type OpenPeerTcpTunnelResult } from './open';
import {
    createPeerTcpTunnelApplicationSubstreamSession,
    createPeerTcpTunnelSubstreamMuxSession,
    createPeerTcpTunnelStreamSession,
    decodePeerTcpTunnelBinaryFrameForSession,
    encodePeerTcpTunnelBinaryFrameForSession,
} from './frames';
import { connectPeerTcpTunnelTcp } from './open';
import { createAtomicRouteGrantConsumption } from './grantConsumption';
import {
    decodePeerTcpTunnelBinaryRoutingHeaderV2,
    peerTcpTunnelBinaryDecodeFailureReason,
} from './routingHeader';
import {
    dispatchDaemonVoiceInferenceSttBinaryAppend,
    dispatchDaemonVoiceInferenceSttTerminal,
    parseDaemonVoiceInferenceSttSubstreamId,
    type PeerTcpTunnelVoiceBinaryAppendConsumer,
    type PeerTcpTunnelVoiceBinaryTerminalConsumer,
} from './voiceBinaryAppend';

const registeredTunnelApps = new WeakSet<FastifyInstance>();
const DEFAULT_DIRECT_TUNNEL_LIMITS: Readonly<{
    maxIdleMs: number;
    maxDurationMs: number;
    maxTotalBytes?: number;
}> = {
    maxIdleMs: Number.MAX_SAFE_INTEGER,
    maxDurationMs: Number.MAX_SAFE_INTEGER,
};
const DEFAULT_OPEN_STREAM_TIMEOUT_MS = 30_000;

export type RegisterPeerTcpTunnelLoopbackRoutesOptions = Omit<OpenPeerTcpTunnelInput, 'open' | 'nowMs' | 'grantConsumption'> & Readonly<{
    nowMs: () => number;
    openTunnel?: (input: OpenPeerTcpTunnelInput) => Promise<OpenPeerTcpTunnelResult>;
    maxActiveTunnels?: number;
    openStreamTimeoutMs?: number;
    voiceBinaryAppendConsumer?: PeerTcpTunnelVoiceBinaryAppendConsumer;
    voiceBinaryTerminalConsumer?: PeerTcpTunnelVoiceBinaryTerminalConsumer;
}>;

type ActivePeerTcpTunnel = (OpenPeerTcpTunnelResult & { ok: true }) & Readonly<{
    open: ReturnType<typeof PeerTcpTunnelOpenV1Schema.parse> | ReturnType<typeof PeerTcpTunnelOpenV2Schema.parse>;
    openStreamTimeout?: ReturnType<typeof setTimeout>;
}>;

type PeerTcpTunnelFastifyWebSocket = Readonly<{
    on: (event: 'message' | 'close', handler: (payload?: unknown) => void) => void;
    send: (payload: string | Uint8Array) => void;
    close: () => void;
}>;

type PeerTcpTunnelLoopbackSession = Readonly<{
    flowKind: ActivePeerTcpTunnel['flowKind'];
    session?: ReturnType<typeof createPeerTcpTunnelStreamSession>;
    applicationSubstreams?: ReturnType<typeof createPeerTcpTunnelApplicationSubstreamSession>;
    substreamMux?: ReturnType<typeof createPeerTcpTunnelSubstreamMuxSession>;
    encoding: ActivePeerTcpTunnel['response']['encoding'];
    maxFrameBytes: number;
    voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
}>;

function readFrameTunnelId(frame: unknown): string | null {
    if (!frame || typeof frame !== 'object') return null;
    const record = frame as Record<string, unknown>;
    if (typeof record.tunnelId === 'string') return record.tunnelId;
    const open = record.open;
    if (open && typeof open === 'object' && typeof (open as Record<string, unknown>).tunnelId === 'string') {
        return (open as Record<string, string>).tunnelId;
    }
    return null;
}

function readOpenTunnelId(open: unknown): string | null {
    const parsedV2 = PeerTcpTunnelOpenV2Schema.safeParse(open);
    if (parsedV2.success) return parsedV2.data.tunnelId;
    const parsedV1 = PeerTcpTunnelOpenV1Schema.safeParse(open);
    return parsedV1.success ? parsedV1.data.tunnelId : null;
}

function toBinaryFramePayload(raw: unknown, maxHeaderBytes: number): Uint8Array | null {
    const bytes =
        raw instanceof Uint8Array
            ? raw
            : raw instanceof ArrayBuffer
                ? new Uint8Array(raw)
                : ArrayBuffer.isView(raw)
                    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
                    : null;
    if (!bytes || bytes.byteLength < 4) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = view.getUint32(0, false);
    if (headerLength < 1 || headerLength > maxHeaderBytes || bytes.byteLength < 4 + headerLength) {
        return null;
    }
    return bytes;
}

function closeSocket(socket: PeerTcpTunnelFastifyWebSocket): void {
    socket.close();
}

export function registerPeerTcpTunnelLoopbackRoutes(
    app: FastifyInstance,
    options: RegisterPeerTcpTunnelLoopbackRoutesOptions,
): void {
    if (registeredTunnelApps.has(app)) {
        throw new Error('Peer mediation tunnel routes already registered on this loopback Fastify app');
    }
    registeredTunnelApps.add(app);

    const openTunnel = options.openTunnel ?? openPeerTcpTunnel;
    const maxActiveTunnels = Math.max(1, Math.floor(options.maxActiveTunnels ?? 8));
    const activeTunnels = new Map<string, ActivePeerTcpTunnel>();
    const grantConsumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'consume' });
    const openStreamTimeoutMs =
        typeof options.openStreamTimeoutMs === 'number' && Number.isFinite(options.openStreamTimeoutMs) && options.openStreamTimeoutMs >= 1
            ? Math.floor(options.openStreamTimeoutMs)
            : DEFAULT_OPEN_STREAM_TIMEOUT_MS;
    app.register(fastifyWebsocket);
    app.register(async (streamRoutes) => {
        streamRoutes.get(PEER_TCP_TUNNEL_STREAM_PATH, { websocket: true }, (socket: PeerTcpTunnelFastifyWebSocket) => {
            const sessions = new Map<string, PeerTcpTunnelLoopbackSession>();
            const getSession = (tunnelId: string) => {
                const existing = sessions.get(tunnelId);
                if (existing) return existing;
                const tunnel = activeTunnels.get(tunnelId);
                if (!tunnel) return null;
                if (tunnel.openStreamTimeout) {
                    clearTimeout(tunnel.openStreamTimeout);
                }
                const limits = tunnel.limits ?? DEFAULT_DIRECT_TUNNEL_LIMITS;
                const session = tunnel.flowKind === 'tcp_tunnel' && tunnel.connection
                    ? createPeerTcpTunnelStreamSession({
                    tunnelId,
                    initialWindowBytes: tunnel.response.initialWindowBytes,
                    maxFrameBytes: tunnel.response.maxFrameBytes,
                    maxIdleMs: limits.maxIdleMs,
                    maxDurationMs: limits.maxDurationMs,
                    maxTotalBytes: limits.maxTotalBytes,
                    connection: tunnel.connection,
                    sendFrame: (frame) => {
                        if (tunnel.response.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 && frame.kind !== 'open') {
                            socket.send(encodePeerTcpTunnelBinaryFrameForSession(frame));
                            return;
                        }
                        socket.send(JSON.stringify(frame));
                    },
                    })
                    : undefined;
                const substreamMux = tunnel.flowKind === 'tcp_tunnel'
                    && tunnel.response.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
                    ? createPeerTcpTunnelSubstreamMuxSession({
                        tunnelId,
                        destination: {
                            host: tunnel.open.destination.host.trim().toLowerCase(),
                            port: tunnel.open.destination.port,
                        },
                        initialWindowBytes: tunnel.response.initialWindowBytes,
                        maxFrameBytes: tunnel.response.maxFrameBytes,
                        maxBinaryHeaderBytes: tunnel.response.maxFrameBytes,
                        maxRawPayloadBytes: tunnel.response.maxFrameBytes,
                        caps: {
                            ...DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
                            maxBytesPerSubstream: tunnel.limits.maxTotalBytes ?? DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxBytesPerSubstream,
                            maxAggregateBytes: tunnel.limits.maxTotalBytes ?? DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxAggregateBytes,
                            maxSubstreamIdleMs: tunnel.limits.maxIdleMs,
                            maxSessionIdleMs: tunnel.limits.maxIdleMs,
                        },
                        connectTcp: options.connectTcp ?? connectPeerTcpTunnelTcp,
                        sendBinaryFrame: (frame) => {
                            socket.send(frame);
                        },
                        nowMs: options.nowMs,
                    })
                    : undefined;
                let applicationSubstreams: ReturnType<typeof createPeerTcpTunnelApplicationSubstreamSession> | undefined;
                if (
                    tunnel.response.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
                    && tunnel.flowKind === 'voice_media'
                    && options.voiceBinaryAppendConsumer
                ) {
                    const aggregateLimit = limits.maxTotalBytes
                        ?? DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxAggregateBytes;
                    applicationSubstreams = createPeerTcpTunnelApplicationSubstreamSession({
                        tunnelId,
                        maxBinaryHeaderBytes: tunnel.response.maxFrameBytes,
                        maxFrameBytes: tunnel.response.maxFrameBytes,
                        maxBytesPerSubstream: aggregateLimit,
                        maxAggregateBytes: aggregateLimit,
                        maxConcurrentSubstreams: DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxConcurrentSubstreams,
                        maxTotalSubstreams: DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxTotalSubstreams,
                        maxSubstreamIdleMs: limits.maxIdleMs,
                        maxSessionIdleMs: limits.maxIdleMs,
                        maxDurationMs: limits.maxDurationMs,
                        sendBinaryFrame: (frame) => socket.send(frame),
                        onTerminal: async ({ reasonCode, substreamIds }) => {
                            try {
                                await dispatchDaemonVoiceInferenceSttTerminal({
                                    consumer: options.voiceBinaryTerminalConsumer,
                                    substreamIds,
                                    reasonCode,
                                    voiceMediaApplicationAuthority: tunnel.voiceMediaApplicationAuthority,
                                });
                            } finally {
                                const current = sessions.get(tunnelId);
                                if (!current || current.applicationSubstreams !== applicationSubstreams) return;
                                sessions.delete(tunnelId);
                                activeTunnels.delete(tunnelId);
                                await current.substreamMux?.close();
                                await current.session?.close();
                            }
                        },
                        nowMs: options.nowMs,
                    });
                }
                const entry = {
                    flowKind: tunnel.flowKind,
                    ...(session ? { session } : {}),
                    ...(substreamMux ? { substreamMux } : {}),
                    ...(applicationSubstreams ? { applicationSubstreams } : {}),
                    encoding: tunnel.response.encoding,
                    maxFrameBytes: tunnel.response.maxFrameBytes,
                    ...(tunnel.voiceMediaApplicationAuthority ? {
                        voiceMediaApplicationAuthority: tunnel.voiceMediaApplicationAuthority,
                    } : {}),
                };
                sessions.set(tunnelId, entry);
                return entry;
            };

            let inboundQueue = Promise.resolve();
            socket.on('message', (raw) => {
                inboundQueue = inboundQueue.then(async () => {
                    const binaryPayload = toBinaryFramePayload(raw, PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES);
                    if (binaryPayload) {
                        const routingHeader = decodePeerTcpTunnelBinaryRoutingHeaderV2({
                            frame: binaryPayload,
                            maxHeaderBytes: PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
                        });
                        if (!routingHeader.ok) {
                            closeSocket(socket);
                            return;
                        }
                        const tunnelId = routingHeader.header.tunnelId;
                        const entry = getSession(tunnelId);
                        if (!entry || entry.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
                            closeSocket(socket);
                            return;
                        }
                        const decodedHeader = decodePeerTcpTunnelBinaryFrameV2({
                            frame: binaryPayload,
                            maxHeaderBytes: entry.maxFrameBytes,
                            // Routing only: the owning parent/substream session applies its own payload cap.
                            maxPayloadBytes: Number.MAX_SAFE_INTEGER,
                        });
                        if (routingHeader.header.substreamId) {
                            const substreamId = routingHeader.header.substreamId;
                            if (
                                entry.applicationSubstreams
                                && entry.flowKind === 'voice_media'
                                && entry.voiceMediaApplicationAuthority?.applicationKind
                                    === 'speech_transcription'
                                && options.voiceBinaryAppendConsumer
                                && parseDaemonVoiceInferenceSttSubstreamId(substreamId)
                            ) {
                                if (!decodedHeader.ok) {
                                    await entry.applicationSubstreams.denySubstream(
                                        substreamId,
                                        peerTcpTunnelBinaryDecodeFailureReason(decodedHeader.reasonCode),
                                    );
                                    return;
                                }
                                await entry.applicationSubstreams.acceptBinaryFrame(binaryPayload, async ({ payload, sequence }) => {
                                    let responsePayload: Uint8Array | null = null;
                                    await dispatchDaemonVoiceInferenceSttBinaryAppend({
                                        consumer: options.voiceBinaryAppendConsumer,
                                        header: {
                                            ...routingHeader.header,
                                            kind: 'data',
                                            direction: 'client_to_daemon',
                                            sequence,
                                        },
                                        payload,
                                        voiceMediaApplicationAuthority: entry.voiceMediaApplicationAuthority,
                                        onResponse: (response) => {
                                            responsePayload = Buffer.from(JSON.stringify(response), 'utf8');
                                        },
                                    });
                                    return responsePayload;
                                });
                                return;
                            }
                            if (!decodedHeader.ok) {
                                closeSocket(socket);
                                return;
                            }
                            await entry.substreamMux?.acceptBinaryFrame(binaryPayload);
                            return;
                        }
                        const decoded = decodePeerTcpTunnelBinaryFrameForSession({
                            frame: binaryPayload,
                            maxBinaryHeaderBytes: entry.maxFrameBytes,
                            maxRawPayloadBytes: entry.maxFrameBytes,
                        });
                        if (!decoded.ok) {
                            closeSocket(socket);
                            return;
                        }
                        if (!entry.session) {
                            closeSocket(socket);
                            return;
                        }
                        await entry.session.acceptFrame(decoded.frame);
                        return;
                    }

                    let frame: unknown;
                    try {
                        frame = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
                    } catch {
                        closeSocket(socket);
                        return;
                    }
                    const tunnelId = readFrameTunnelId(frame);
                    if (!tunnelId) {
                        closeSocket(socket);
                        return;
                    }
                    const entry = getSession(tunnelId);
                    if (!entry || entry.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
                        closeSocket(socket);
                        return;
                    }
                    if (!entry.session) {
                        closeSocket(socket);
                        return;
                    }
                    await entry.session.acceptFrame(frame);
                }).catch(() => {
                    closeSocket(socket);
                });
            });

            socket.on('close', () => {
                for (const [tunnelId, entry] of sessions) {
                    if (entry.applicationSubstreams) {
                        void entry.applicationSubstreams.close();
                        continue;
                    }
                    void entry.substreamMux?.close();
                    void entry.session?.close();
                    activeTunnels.delete(tunnelId);
                    sessions.delete(tunnelId);
                }
            });
        });
    });
    app.addHook('onClose', async () => {
        for (const tunnel of activeTunnels.values()) {
            if (tunnel.openStreamTimeout) {
                clearTimeout(tunnel.openStreamTimeout);
            }
            await tunnel.connection?.close();
        }
        activeTunnels.clear();
        grantConsumption.clear();
    });

    const handleOpen = async (request: FastifyRequest, reply: FastifyReply) => {
        const tunnelId = readOpenTunnelId(request.body);
        if (tunnelId && activeTunnels.has(tunnelId)) {
            reply.code(409);
            return {
                ok: false,
                reasonCode: 'tunnel_id_already_open',
            };
        }
        if (tunnelId && activeTunnels.size >= maxActiveTunnels) {
            reply.code(429);
            return {
                ok: false,
                reasonCode: 'direct_tunnel_cap_exceeded',
            };
        }
        const result = await openTunnel({
            ...options,
            nowMs: options.nowMs(),
            grantConsumption,
            open: request.body,
        });
        if (!result.ok) {
            reply.code(400);
            return result;
        }
        const openStreamTimeout = openStreamTimeoutMs == null
            ? undefined
            : setTimeout(() => {
                const activeTunnel = activeTunnels.get(result.response.tunnelId);
                if (!activeTunnel || activeTunnel.openStreamTimeout !== openStreamTimeout) return;
                if (activeTunnel.openStreamTimeout) {
                    clearTimeout(activeTunnel.openStreamTimeout);
                }
                void activeTunnel.connection?.close();
                activeTunnels.delete(result.response.tunnelId);
                void dispatchDaemonVoiceInferenceSttTerminal({
                    consumer: options.voiceBinaryTerminalConsumer,
                    substreamIds: [],
                    reasonCode: 'tunnel_open_timeout',
                    voiceMediaApplicationAuthority: activeTunnel.voiceMediaApplicationAuthority,
                }).catch(() => undefined);
            }, openStreamTimeoutMs);
        openStreamTimeout?.unref?.();
        activeTunnels.set(result.response.tunnelId, {
            ...result,
            open: result.response.tunnelId && PeerTcpTunnelOpenV2Schema.safeParse(request.body).success
                ? PeerTcpTunnelOpenV2Schema.parse(request.body)
                : PeerTcpTunnelOpenV1Schema.parse(request.body),
            ...(openStreamTimeout ? { openStreamTimeout } : {}),
        });
        return result.response;
    };
    app.post(PEER_TCP_TUNNEL_OPEN_PATH, handleOpen);
    app.post(PEER_TCP_TUNNEL_OPEN_PATH_V2, handleOpen);
}
