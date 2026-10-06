import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';

import { DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { decodePeerTcpTunnelBinaryFrameHeaderV2, decodePeerTcpTunnelBinaryFrameV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import { PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES, PEER_TCP_TUNNEL_STREAM_PATH } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { PEER_TCP_TUNNEL_OPEN_PATH_V2, PeerTcpTunnelOpenV2Schema } from '@happier-dev/protocol/machines/peer/mediation/tunnel/openAuthorizationV2';
import type { PeerFlowKindV1, VoiceMediaApplicationAuthorityV1 } from '@happier-dev/protocol';

import { openPeerTcpTunnel, type OpenPeerTcpTunnelInput, type OpenPeerTcpTunnelResult } from './open';
import {
    createPeerTcpTunnelApplicationSubstreamSession,
    createPeerTcpTunnelSubstreamMuxSession,
    decodePeerTcpTunnelBinaryFrameForSession,
    peerTcpTunnelBinaryDecodeFailureReason,
} from './frames';
import { connectPeerTcpTunnelTcp } from './open';
import type { DaemonPeerMediationDirectFlowObserver } from '../observability/events';
import { createAtomicRouteGrantConsumption } from './grantConsumption';
import {
    dispatchDaemonVoiceInferenceSttBinaryAppend,
    dispatchDaemonVoiceInferenceSttTerminal,
    parseDaemonVoiceInferenceSttSubstreamId,
    type PeerTcpTunnelVoiceBinaryAppendConsumer,
    type PeerTcpTunnelVoiceBinaryTerminalConsumer,
} from './voiceBinaryAppend';

const registeredTunnelApps = new WeakSet<FastifyInstance>();
const DEFAULT_OPEN_STREAM_TIMEOUT_MS = 30_000;

export type RegisterPeerTcpTunnelLoopbackRoutesOptions = Omit<OpenPeerTcpTunnelInput, 'open' | 'nowMs' | 'grantConsumption'> & Readonly<{
    nowMs: () => number;
    resolveTrustRoots?: () => OpenPeerTcpTunnelInput['trustRoots'];
    /** Scope-bound PMS-9 observer supplied by the loopback composition root (P1-9). */
    observability?: DaemonPeerMediationDirectFlowObserver;
    openTunnel?: (input: OpenPeerTcpTunnelInput) => Promise<OpenPeerTcpTunnelResult>;
    maxActiveTunnels?: number;
    openStreamTimeoutMs?: number;
    voiceBinaryAppendConsumer?: PeerTcpTunnelVoiceBinaryAppendConsumer;
    voiceBinaryTerminalConsumer?: PeerTcpTunnelVoiceBinaryTerminalConsumer;
}>;

type ActivePeerTcpTunnel = (OpenPeerTcpTunnelResult & { ok: true }) & Readonly<{
    openStreamTimeout?: ReturnType<typeof setTimeout>;
}> & {
    closeTransport?: () => void;
    onPreviewAbort?: () => void;
    pendingControl?: Readonly<{ detach: () => void; close: () => void }>;
};

type PeerTcpTunnelFastifyWebSocket = Readonly<{
    on: (event: 'message' | 'close', handler: (payload?: unknown) => void) => void;
    send: (payload: string | Uint8Array) => void;
    close: () => void;
}>;

type PeerTcpTunnelLoopbackSession = Readonly<{
    flowKind: ActivePeerTcpTunnel['flowKind'];
    applicationSubstreams?: ReturnType<typeof createPeerTcpTunnelApplicationSubstreamSession>;
    substreamMux?: ReturnType<typeof createPeerTcpTunnelSubstreamMuxSession>;
    encoding: ActivePeerTcpTunnel['response']['encoding'];
    maxFrameBytes: number;
    voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
}>;

function readOpenTunnelId(open: unknown): string | null {
    const parsedV2 = PeerTcpTunnelOpenV2Schema.safeParse(open);
    if (parsedV2.success) return parsedV2.data.tunnelId;
    return null;
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
    const releaseTunnel = (tunnelId: string): void => {
        const tunnel = activeTunnels.get(tunnelId);
        if (!tunnel) return;
        activeTunnels.delete(tunnelId);
        if (tunnel.openStreamTimeout) clearTimeout(tunnel.openStreamTimeout);
        if (tunnel.onPreviewAbort) tunnel.previewApplication?.signal.removeEventListener('abort', tunnel.onPreviewAbort);
        tunnel.pendingControl?.close();
        tunnel.closeTransport?.();
        void tunnel.previewApplication?.close();
    };
    const grantConsumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'consume' });
    const openStreamTimeoutMs =
        typeof options.openStreamTimeoutMs === 'number' && Number.isFinite(options.openStreamTimeoutMs) && options.openStreamTimeoutMs >= 1
            ? Math.floor(options.openStreamTimeoutMs)
            : DEFAULT_OPEN_STREAM_TIMEOUT_MS;
    app.register(fastifyWebsocket);
    app.register(async (streamRoutes) => {
        streamRoutes.get(PEER_TCP_TUNNEL_STREAM_PATH, { websocket: true }, (socket: PeerTcpTunnelFastifyWebSocket, request) => {
            const query = new URL(request.raw.url ?? '/', 'http://localhost').searchParams;
            const previewTunnelIds = query.getAll('tunnelId');
            const previewTunnelId = previewTunnelIds.length === 1 ? previewTunnelIds[0] : null;
            const sessions = new Map<string, PeerTcpTunnelLoopbackSession>();
            const getSession = (tunnelId: string, attachPreview = false) => {
                if (previewTunnelId && tunnelId !== previewTunnelId) return null;
                const existing = sessions.get(tunnelId);
                if (existing) return existing;
                const tunnel = activeTunnels.get(tunnelId);
                if (!tunnel) return null;
                if (tunnel.previewApplication && (!attachPreview || tunnel.closeTransport)) return null;
                if (attachPreview && !tunnel.previewApplication) return null;
                if (tunnel.openStreamTimeout) {
                    clearTimeout(tunnel.openStreamTimeout);
                }
                const limits = tunnel.limits;
                // The open owner is the single destination normalizer; the mux dials exactly the
                // destination it admitted.
                const destination = tunnel.destination;
                const substreamMux = tunnel.flowKind === 'tcp_tunnel'
                    && destination
                    && tunnel.response.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
                    ? createPeerTcpTunnelSubstreamMuxSession({
                        tunnelId,
                        destination,
                        initialWindowBytes: tunnel.response.initialWindowBytes,
                        maxFrameBytes: tunnel.response.maxFrameBytes,
                        maxBinaryHeaderBytes: tunnel.response.maxFrameBytes,
                        maxRawPayloadBytes: tunnel.response.maxFrameBytes,
                        caps: DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
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
                    const aggregateLimit = limits.maxTotalBytes;
                    applicationSubstreams = createPeerTcpTunnelApplicationSubstreamSession({
                        tunnelId,
                        maxBinaryHeaderBytes: tunnel.response.maxFrameBytes,
                        maxFrameBytes: tunnel.response.maxFrameBytes,
                        maxBytesPerSubstream: aggregateLimit,
                        maxAggregateBytes: aggregateLimit,
                        maxConcurrentSubstreams: DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxConcurrentSubstreams,
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
                                releaseTunnel(tunnelId);
                                await current.substreamMux?.close();
                            }
                        },
                        nowMs: options.nowMs,
                    });
                }
                const entry = {
                    flowKind: tunnel.flowKind,
                    ...(substreamMux ? { substreamMux } : {}),
                    ...(applicationSubstreams ? { applicationSubstreams } : {}),
                    encoding: tunnel.response.encoding,
                    maxFrameBytes: tunnel.response.maxFrameBytes,
                    ...(tunnel.voiceMediaApplicationAuthority ? {
                        voiceMediaApplicationAuthority: tunnel.voiceMediaApplicationAuthority,
                    } : {}),
                };
                sessions.set(tunnelId, entry);
                if (tunnel.previewApplication) {
                    tunnel.closeTransport = () => closeSocket(socket);
                    tunnel.pendingControl?.detach();
                    delete tunnel.pendingControl;
                }
                return entry;
            };

            let inboundQueue = Promise.resolve();
            socket.on('message', (raw) => {
                inboundQueue = inboundQueue.then(async () => {
                    const binaryPayload = toBinaryFramePayload(raw, PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES);
                    if (binaryPayload) {
                        const routingHeader = decodePeerTcpTunnelBinaryFrameHeaderV2({
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
                        if (!entry.substreamMux || (decoded.frame.kind !== 'close' && decoded.frame.kind !== 'abort')) {
                            closeSocket(socket);
                            return;
                        }
                        await entry.substreamMux.close();
                        sessions.delete(tunnelId);
                        releaseTunnel(tunnelId);
                        return;
                    }

                    closeSocket(socket);
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
                    releaseTunnel(tunnelId);
                    sessions.delete(tunnelId);
                }
            });
            // Native previews attach their already-admitted exact tunnel before any guest
            // frames. The established WS now owns even an idle viewer's registration.
            if (previewTunnelIds.length > 0
                && (!previewTunnelId || previewTunnelIds.length !== 1 || !getSession(previewTunnelId, true))) {
                closeSocket(socket);
            }
        });
    });
    app.addHook('onClose', async () => {
        for (const tunnelId of activeTunnels.keys()) releaseTunnel(tunnelId);
        grantConsumption.clear();
    });

    /**
     * PMS-9 / P1-9: the direct tunnel open is a flow lifecycle boundary. Denials carry the real
     * reason code (`tunnel_id_already_open`, `direct_tunnel_cap_exceeded`, or the open result's own
     * code) instead of vanishing, and an admitted tunnel publishes `flow.ready`.
     */
    const observeTunnel = (input: Readonly<{
        tunnelId: string;
        kind: Parameters<DaemonPeerMediationDirectFlowObserver['emit']>[0]['kind'];
        routeKind?: Extract<OpenPeerTcpTunnelResult, { ok: true }>['routeKind'];
        flowKind?: PeerFlowKindV1;
        reasonCode?: string;
    }>): void => {
        options.observability?.emit({
            flowKind: input.flowKind ?? 'tcp_tunnel',
            flowId: input.tunnelId,
            kind: input.kind,
            ...(input.routeKind ? { routeKind: input.routeKind } : {}),
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        });
    };

    const handleOpen = async (request: FastifyRequest, reply: FastifyReply) => {
        const tunnelId = readOpenTunnelId(request.body);
        if (tunnelId && activeTunnels.has(tunnelId)) {
            reply.code(409);
            observeTunnel({ tunnelId, kind: 'flow.denied', reasonCode: 'tunnel_id_already_open' });
            return {
                ok: false,
                reasonCode: 'tunnel_id_already_open',
            };
        }
        if (tunnelId && activeTunnels.size >= maxActiveTunnels) {
            reply.code(429);
            observeTunnel({ tunnelId, kind: 'cap.exceeded', reasonCode: 'direct_tunnel_cap_exceeded' });
            return {
                ok: false,
                reasonCode: 'direct_tunnel_cap_exceeded',
            };
        }
        const cancellation = new AbortController();
        const onCancel = () => cancellation.abort();
        const onResponseClose = () => { if (!reply.raw.writableEnded) onCancel(); };
        request.raw.once('aborted', onCancel);
        reply.raw.once('close', onResponseClose);
        app.server.once('close', onCancel);
        const result = await openTunnel({
            ...options,
            trustRoots: options.resolveTrustRoots?.() ?? options.trustRoots,
            nowMs: options.nowMs(),
            grantConsumption,
            open: request.body,
            signal: cancellation.signal,
        }).finally(() => {
            request.raw.off('aborted', onCancel);
            reply.raw.off('close', onResponseClose);
            app.server.off('close', onCancel);
        });
        if (!result.ok) {
            reply.code(400);
            if (tunnelId) {
                observeTunnel({ tunnelId, kind: 'flow.denied', reasonCode: result.reasonCode });
            }
            return result;
        }
        const openStreamTimeout = result.previewApplication || openStreamTimeoutMs == null
            ? undefined
            : setTimeout(() => {
                const activeTunnel = activeTunnels.get(result.response.tunnelId);
                if (!activeTunnel || activeTunnel.openStreamTimeout !== openStreamTimeout) return;
                if (activeTunnel.openStreamTimeout) {
                    clearTimeout(activeTunnel.openStreamTimeout);
                }
                releaseTunnel(result.response.tunnelId);
                void dispatchDaemonVoiceInferenceSttTerminal({
                    consumer: options.voiceBinaryTerminalConsumer,
                    substreamIds: [],
                    reasonCode: 'tunnel_open_timeout',
                    voiceMediaApplicationAuthority: activeTunnel.voiceMediaApplicationAuthority,
                }).catch(() => undefined);
                observeTunnel({
                    tunnelId: result.response.tunnelId,
                    kind: 'flow.aborted',
                    reasonCode: 'tunnel_open_timeout',
                    routeKind: activeTunnel.routeKind,
                    ...(activeTunnel.flowKind ? { flowKind: activeTunnel.flowKind } : {}),
                });
            }, openStreamTimeoutMs);
        openStreamTimeout?.unref?.();
        const activeTunnel: ActivePeerTcpTunnel = {
            ...result,
            ...(openStreamTimeout ? { openStreamTimeout } : {}),
        };
        activeTunnels.set(result.response.tunnelId, activeTunnel);
        if (result.previewApplication) {
            const controlSocket = request.raw.socket;
            const onControlClose = () => {
                if (activeTunnels.get(result.response.tunnelId) === activeTunnel && !activeTunnel.closeTransport) {
                    releaseTunnel(result.response.tunnelId);
                }
            };
            const detach = () => controlSocket.off('close', onControlClose);
            activeTunnel.pendingControl = {
                detach,
                close: () => { detach(); controlSocket.destroy(); },
            };
            controlSocket.once('close', onControlClose);
            // Node installs its keep-alive timeout on response finish. Register after its
            // listener so pending registration custody has no shorter HTTP-phase cutoff.
            reply.raw.once('finish', () => {
                if (activeTunnels.get(result.response.tunnelId) === activeTunnel && !activeTunnel.closeTransport) {
                    controlSocket.setTimeout(0);
                }
            });
            activeTunnel.onPreviewAbort = () => releaseTunnel(result.response.tunnelId);
            result.previewApplication.signal.addEventListener('abort', activeTunnel.onPreviewAbort, { once: true });
            if (result.previewApplication.signal.aborted) activeTunnel.onPreviewAbort();
            if (controlSocket.destroyed) onControlClose();
        }
        observeTunnel({
            tunnelId: result.response.tunnelId,
            kind: 'flow.ready',
            routeKind: result.routeKind,
            ...(result.flowKind ? { flowKind: result.flowKind } : {}),
        });
        return result.response;
    };
    app.post(PEER_TCP_TUNNEL_OPEN_PATH_V2, handleOpen);
}
