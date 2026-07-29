import {
    PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
    PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES,
    decodePeerTcpTunnelBinaryFrameV2,
    PeerTcpTunnelRelayEnvelopeSchema,
    verifyPeerTcpTunnelRelayAuthorizationV2,
    createPeerApplicationAuthorityDigestV1,
    type MachineTunnelSubstreamCapabilities,
    type PeerTcpTunnelEncoding,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelOpenV1,
    type PeerTcpTunnelRelayAuthorizationPayloadV2,
    type PeerTcpTunnelRelayAuthorizationTrustRootV1,
    type PeerTcpTunnelRelayBinaryEnvelopeV2,
    type PeerTcpTunnelRelayEnvelope,
    type PeerTcpTunnelRelayEnvelopeV1,
    type PeerApplicationEncryptionAuthorityBindingV1,
} from '@happier-dev/protocol';

import {
    createPeerTcpTunnelApplicationSubstreamSession,
    createPeerTcpTunnelSubstreamMuxSession,
    createPeerTcpTunnelStreamSession,
    decodePeerTcpTunnelBinaryFrameForSession,
    encodePeerTcpTunnelBinaryFrameForSession,
} from './frames';
import { isPeerTcpTunnelLoopbackDestinationHost, type PeerTcpTunnelTcpConnection } from './open';
import {
    createDaemonPeerMediationFlowEvent,
    type DaemonPeerMediationObservabilityEmitter,
    type DaemonPeerMediationObservabilityEventKind,
} from '../observability/events';
import {
    dispatchDaemonVoiceInferenceSttBinaryAppend,
    dispatchDaemonVoiceInferenceSttTerminal,
    parseDaemonVoiceInferenceSttSubstreamId,
    type PeerTcpTunnelVoiceBinaryAppendConsumer,
    type PeerTcpTunnelVoiceBinaryTerminalConsumer,
} from './voiceBinaryAppend';
import {
    dispatchVoiceMediaAgentRealtimeBinaryFrame,
    type VoiceMediaAgentRealtimeApplicationConsumer,
} from '../../../voiceMedia/voiceMediaApplicationDispatcher';
import { voiceMediaPeerApplicationEncryptionRegistry } from '../../../voiceMedia/voiceMediaPeerApplicationEncryption';
import { createAtomicRouteGrantConsumption } from './grantConsumption';
import {
    decodePeerTcpTunnelBinaryRoutingHeaderV2,
    peerTcpTunnelBinaryDecodeFailureReason,
} from './routingHeader';

type PeerTcpTunnelRelaySocket = Readonly<{
    on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => unknown;
    emit: (event: string, payload: unknown) => unknown;
}>;

type ActiveRelayTunnel = Readonly<{
    session?: ReturnType<typeof createPeerTcpTunnelStreamSession>;
    applicationSubstreams?: ReturnType<typeof createPeerTcpTunnelApplicationSubstreamSession>;
    substreamMux?: ReturnType<typeof createPeerTcpTunnelSubstreamMuxSession>;
    encoding: PeerTcpTunnelEncoding;
    flowKind: PeerTcpTunnelRelayAuthorizationPayloadV2['flowKind'];
    maxFrameBytes: number;
    maxTotalBytes?: number;
    peerApplicationEncryption?: PeerApplicationEncryptionAuthorityBindingV1;
    applicationAbortController?: AbortController;
}>;

function encodeVoiceConsumerResponse(response: unknown): Uint8Array {
    return response instanceof Uint8Array ? response : Buffer.from(JSON.stringify(response), 'utf8');
}

export type RegisterPeerTcpTunnelRelayTerminatorOptions = Readonly<{
    accountId: string;
    machineId: string;
    socket: PeerTcpTunnelRelaySocket;
    nowMs: () => number;
    relayAuthorizationTrustRoots: readonly PeerTcpTunnelRelayAuthorizationTrustRootV1[];
    connectTcp: (target: Readonly<{ host: string; port: number }>) => Promise<PeerTcpTunnelTcpConnection>;
    initialWindowBytes?: number;
    maxFrameBytes?: number;
    maxBinaryHeaderBytes?: number;
    maxRawPayloadBytes?: number;
    maxFramedMessageBytes?: number;
    maxActiveTunnels?: number;
    substreamCaps?: MachineTunnelSubstreamCapabilities;
    observability?: DaemonPeerMediationObservabilityEmitter;
    voiceBinaryAppendConsumer?: PeerTcpTunnelVoiceBinaryAppendConsumer;
    voiceBinaryTerminalConsumer?: PeerTcpTunnelVoiceBinaryTerminalConsumer;
    voiceMediaAgentRealtimeConsumer?: VoiceMediaAgentRealtimeApplicationConsumer;
}>;

function normalizeDestinationHost(host: string): string {
    const trimmed = host.trim().toLowerCase();
    return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function validateRelayAuthorizationBinding(input: Readonly<{
    open: PeerTcpTunnelOpenV1;
    payload: PeerTcpTunnelRelayAuthorizationPayloadV2;
}>): boolean {
    return input.payload.routeKind === input.open.routeKind
        && input.payload.tunnelId === input.open.tunnelId
        && input.payload.targetMachineId === input.open.targetMachineId
        && normalizeDestinationHost(input.payload.destination.host) === normalizeDestinationHost(input.open.destination.host)
        && input.payload.destination.port === input.open.destination.port;
}

function frameTunnelId(frame: PeerTcpTunnelFrameV1): string {
    return frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
}

function selectedOpenEncoding(frame: PeerTcpTunnelFrameV1): PeerTcpTunnelEncoding {
    return frame.kind === 'open'
        ? frame.open.selectedEncoding ?? PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1
        : PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1;
}

function dataFrameBytes(frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>): number {
    if (frame.kind !== 'data') return 0;
    return Buffer.byteLength(frame.payloadBase64, 'base64');
}

function buildEnvelope(input: Readonly<{
    accountId: string;
    machineId: string;
    frame: PeerTcpTunnelFrameV1;
}>): PeerTcpTunnelRelayEnvelopeV1 {
    return {
        v: 1,
        scopeUserId: input.accountId,
        sender: { kind: 'machine', machineId: input.machineId },
        recipient: { kind: 'user' },
        frame: input.frame,
    };
}

function buildBinaryEnvelope(input: Readonly<{
    accountId: string;
    machineId: string;
    frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
}>): PeerTcpTunnelRelayBinaryEnvelopeV2 {
    return {
        v: 2,
        scopeUserId: input.accountId,
        sender: { kind: 'machine', machineId: input.machineId },
        recipient: { kind: 'user' },
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        frame: encodePeerTcpTunnelBinaryFrameForSession(input.frame),
    };
}

function abortFrame(tunnelId: string, reasonCode: string): PeerTcpTunnelFrameV1 {
    return {
        v: 1,
        kind: 'abort',
        tunnelId,
        reasonCode,
    };
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readInvalidRelayAuthorizationOpenTunnelId(input: Readonly<{
    raw: unknown;
    accountId: string;
    machineId: string;
}>): string | null {
    const envelope = readRecord(input.raw);
    if (!envelope || envelope.v !== 1 || envelope.scopeUserId !== input.accountId) return null;
    const sender = readRecord(envelope.sender);
    const recipient = readRecord(envelope.recipient);
    if (sender?.kind !== 'user') return null;
    if (recipient?.kind !== 'machine' || recipient.machineId !== input.machineId) return null;
    const frame = readRecord(envelope.frame);
    const open = readRecord(frame?.open);
    if (frame?.kind !== 'open' || open?.kind !== 'open') return null;
    if (open.routeKind !== 'server_relay' || readRecord(open.relayAuthorization) === null) return null;
    return typeof open.tunnelId === 'string' && open.tunnelId.length > 0 ? open.tunnelId : null;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
    const normalized = Math.floor(value ?? fallback);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function resolveSubstreamCaps(input: Readonly<{
    configured: MachineTunnelSubstreamCapabilities | undefined;
    authorization: PeerTcpTunnelRelayAuthorizationPayloadV2;
}>): MachineTunnelSubstreamCapabilities {
    const configured = input.configured ?? DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES;
    const authorizationMaxBytes = input.authorization.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;
    return {
        maxConcurrentSubstreams: configured.maxConcurrentSubstreams,
        maxTotalSubstreams: configured.maxTotalSubstreams,
        maxBytesPerSubstream: Math.min(configured.maxBytesPerSubstream, authorizationMaxBytes),
        maxAggregateBytes: Math.min(configured.maxAggregateBytes, authorizationMaxBytes),
        maxSubstreamIdleMs: Math.min(configured.maxSubstreamIdleMs, input.authorization.maxIdleMs),
        maxSessionIdleMs: Math.min(configured.maxSessionIdleMs, input.authorization.maxIdleMs),
    };
}

export function registerPeerTcpTunnelRelayTerminator(
    options: RegisterPeerTcpTunnelRelayTerminatorOptions,
): void {
    const activeTunnels = new Map<string, ActiveRelayTunnel>();
    const openingTunnels = new Set<string>();
    const pendingFramesByOpeningTunnel = new Map<string, PeerTcpTunnelRelayEnvelope[]>();
    const grantConsumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'consume' });
    const bytesByTunnelId = new Map<string, { in: number; out: number }>();
    const maxActiveTunnels = normalizePositiveInt(options.maxActiveTunnels, 8);
    const maxFrameBytes = normalizePositiveInt(options.maxFrameBytes, PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES);
    const maxBinaryHeaderBytes = normalizePositiveInt(options.maxBinaryHeaderBytes, maxFrameBytes);
    const maxRawPayloadBytes = normalizePositiveInt(options.maxRawPayloadBytes, maxFrameBytes);
    const maxFramedMessageBytes = normalizePositiveInt(
        options.maxFramedMessageBytes,
        Math.max(maxFrameBytes, maxBinaryHeaderBytes + maxRawPayloadBytes + 4),
    );

    function emitObservability(input: Readonly<{
        kind: DaemonPeerMediationObservabilityEventKind;
        tunnelId: string;
        flowKind?: ActiveRelayTunnel['flowKind'];
        reasonCode?: string;
        routeGrantId?: string;
        bytesIn?: number;
        bytesOut?: number;
        metadata?: Readonly<Record<string, unknown>>;
    }>): void {
        options.observability?.emit(createDaemonPeerMediationFlowEvent({
            accountId: options.accountId,
            machineId: options.machineId,
            flowKind: input.flowKind ?? activeTunnels.get(input.tunnelId)?.flowKind ?? 'tcp_tunnel',
            flowId: input.tunnelId,
            kind: input.kind,
            nowMs: options.nowMs(),
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            ...(input.routeGrantId ? { routeGrantId: input.routeGrantId } : {}),
            ...(input.bytesIn !== undefined ? { bytesIn: input.bytesIn } : {}),
            ...(input.bytesOut !== undefined ? { bytesOut: input.bytesOut } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
        }));
    }

    async function recordFrameBytes(
        frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>,
        maxTotalBytes?: number,
    ): Promise<boolean> {
        if (frame.kind !== 'data') return true;
        const current = bytesByTunnelId.get(frame.tunnelId) ?? { in: 0, out: 0 };
        const bytes = dataFrameBytes(frame);
        const next = frame.direction === 'client_to_daemon'
            ? { in: current.in + bytes, out: current.out }
            : { in: current.in, out: current.out + bytes };
        if (maxTotalBytes !== undefined && next.in + next.out > maxTotalBytes) {
            emitObservability({
                kind: 'cap.exceeded',
                tunnelId: frame.tunnelId,
                reasonCode: 'total_bytes_exceeded',
                bytesIn: current.in,
                bytesOut: current.out,
            });
            emitAbort(frame.tunnelId, 'total_bytes_exceeded');
            await closeTunnel(frame.tunnelId);
            return false;
        }
        bytesByTunnelId.set(frame.tunnelId, next);
        return true;
    }

    function emitFrame(frame: PeerTcpTunnelFrameV1): void {
        options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, buildEnvelope({
            accountId: options.accountId,
            machineId: options.machineId,
            frame,
        }));
    }

    function emitSessionFrame(encoding: PeerTcpTunnelEncoding, frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>): void {
        if (encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
            options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, buildBinaryEnvelope({
                accountId: options.accountId,
                machineId: options.machineId,
                frame,
            }));
            return;
        }
        emitFrame(frame);
    }

    function emitAbort(tunnelId: string, reasonCode: string): void {
        emitFrame(abortFrame(tunnelId, reasonCode));
    }

    async function closeTunnel(
        tunnelId: string,
        input?: Readonly<{ skipApplicationSubstreamClose?: boolean }>,
    ): Promise<void> {
        const active = activeTunnels.get(tunnelId);
        const bytes = bytesByTunnelId.get(tunnelId);
        activeTunnels.delete(tunnelId);
        openingTunnels.delete(tunnelId);
        pendingFramesByOpeningTunnel.delete(tunnelId);
        bytesByTunnelId.delete(tunnelId);
        if (active) {
            emitObservability({
                kind: 'flow.closed',
                tunnelId,
                flowKind: active.flowKind,
                ...(bytes ? { bytesIn: bytes.in, bytesOut: bytes.out } : {}),
            });
        }
        active?.applicationAbortController?.abort('tunnel_closed');
        if (
            active?.peerApplicationEncryption?.applicationKind === 'agent_realtime'
            && options.voiceMediaAgentRealtimeConsumer
        ) {
            await options.voiceMediaAgentRealtimeConsumer.close({
                authority: active.peerApplicationEncryption,
                substreamId:
                    `agent.realtime.${active.peerApplicationEncryption.applicationAttemptId}`,
                reasonCode: 'tunnel_closed',
            });
        }
        if (!input?.skipApplicationSubstreamClose) {
            await active?.applicationSubstreams?.close();
        }
        await active?.substreamMux?.close();
        await active?.session?.close();
    }

    async function denyActiveTunnelFrame(input: Readonly<{
        tunnelId: string;
        reasonCode: string;
        observabilityKind?: DaemonPeerMediationObservabilityEventKind;
    }>): Promise<void> {
        emitObservability({
            kind: input.observabilityKind ?? 'flow.denied',
            tunnelId: input.tunnelId,
            reasonCode: input.reasonCode,
        });
        emitAbort(input.tunnelId, input.reasonCode);
        await closeTunnel(input.tunnelId);
    }

    async function rejectIfSignedFrameCapExceeded(input: Readonly<{
        active: ActiveRelayTunnel;
        tunnelId: string;
        payloadBytes: number;
    }>): Promise<boolean> {
        if (input.payloadBytes <= input.active.maxFrameBytes) return false;
        await denyActiveTunnelFrame({
            tunnelId: input.tunnelId,
            reasonCode: 'max_frame_bytes_exceeded',
            observabilityKind: 'cap.exceeded',
        });
        return true;
    }

    async function rejectIfVoiceRelayCarriesGenericFrame(input: Readonly<{
        active: ActiveRelayTunnel;
        tunnelId: string;
        allowed: boolean;
    }>): Promise<boolean> {
        if (input.allowed) return false;
        await denyActiveTunnelFrame({
            tunnelId: input.tunnelId,
            reasonCode: 'voice_relay_frame_not_allowed',
        });
        return true;
    }

    function isTerminalFrame(frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>): boolean {
        return frame.kind === 'close' || frame.kind === 'abort';
    }

    function queueFrameForOpeningTunnel(tunnelId: string, envelope: PeerTcpTunnelRelayEnvelope): boolean {
        if (!openingTunnels.has(tunnelId)) return false;
        if (envelope.v === 1 && isTerminalFrame(envelope.frame as Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>)) {
            pendingFramesByOpeningTunnel.delete(tunnelId);
            return true;
        }
        const existing = pendingFramesByOpeningTunnel.get(tunnelId) ?? [];
        existing.push(envelope);
        pendingFramesByOpeningTunnel.set(tunnelId, existing);
        return true;
    }

    async function drainFramesForOpenedTunnel(tunnelId: string): Promise<void> {
        const pending = pendingFramesByOpeningTunnel.get(tunnelId) ?? [];
        pendingFramesByOpeningTunnel.delete(tunnelId);
        for (const envelope of pending) {
            await handleEnvelope(envelope);
        }
    }

    async function openTunnel(envelope: PeerTcpTunnelRelayEnvelopeV1): Promise<void> {
        const open = envelope.frame.kind === 'open' ? envelope.frame.open : null;
        if (!open) return;
        const tunnelId = open.tunnelId;

        if (envelope.scopeUserId !== options.accountId || envelope.sender.kind !== 'user') {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'relay_authorization_invalid',
                routeGrantId: open.relayAuthorization?.payload.grantId,
            });
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        if (envelope.recipient.kind !== 'machine' || envelope.recipient.machineId !== options.machineId) {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'relay_authorization_invalid',
                routeGrantId: open.relayAuthorization?.payload.grantId,
            });
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        if (open.targetMachineId !== options.machineId || open.routeKind !== 'server_relay') {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'relay_authorization_invalid',
                routeGrantId: open.relayAuthorization?.payload.grantId,
            });
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }

        const verification = verifyPeerTcpTunnelRelayAuthorizationV2({
            authorization: open.relayAuthorization,
            nowMs: options.nowMs(),
            trustRoots: options.relayAuthorizationTrustRoots,
        });
        if (
            !verification.valid
            || verification.payload.accountId !== options.accountId
            || envelope.sender.socketId !== verification.payload.relaySocketId
        ) {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'relay_authorization_invalid',
                routeGrantId: open.relayAuthorization?.payload.grantId,
            });
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        if (!validateRelayAuthorizationBinding({ open, payload: verification.payload })) {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'relay_authorization_invalid',
                routeGrantId: verification.payload.grantId,
            });
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        if (activeTunnels.has(tunnelId) || openingTunnels.has(tunnelId)) {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'tunnel_id_already_open',
                routeGrantId: verification.payload.grantId,
            });
            emitAbort(tunnelId, 'tunnel_id_already_open');
            return;
        }
        if (activeTunnels.size + openingTunnels.size >= maxActiveTunnels) {
            emitObservability({
                kind: 'cap.exceeded',
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
                routeGrantId: verification.payload.grantId,
            });
            emitAbort(tunnelId, 'relay_cap_exceeded');
            return;
        }
        if (!isPeerTcpTunnelLoopbackDestinationHost(open.destination.host)) {
            emitObservability({
                kind: 'policy.denied',
                tunnelId,
                reasonCode: 'destination_host_not_allowed',
                routeGrantId: verification.payload.grantId,
                metadata: { destinationHost: open.destination.host, destinationPort: open.destination.port },
            });
            emitAbort(tunnelId, 'destination_host_not_allowed');
            return;
        }
        const grantReservation = grantConsumption.reserve({
            grantId: verification.payload.grantId,
            expiresAt: verification.payload.exp,
            nowMs: options.nowMs(),
        });
        if (!grantReservation) {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'relay_authorization_invalid',
                routeGrantId: verification.payload.grantId,
            });
            emitAbort(tunnelId, 'relay_authorization_invalid');
            return;
        }
        const peerApplicationEncryption =
            verification.payload.flowKind === 'voice_media' && open.relayAuthorization
                ? {
                    v: 1 as const,
                    suite: 'aes-256-gcm' as const,
                    flowKind: 'voice_media' as const,
                    routeKind: 'server_relay' as const,
                    authorityDigest: createPeerApplicationAuthorityDigestV1(open.relayAuthorization),
                    accountId: verification.payload.accountId,
                    machineId: verification.payload.targetMachineId,
                    tunnelId: verification.payload.tunnelId,
                    applicationKind: verification.payload.applicationKind!,
                    applicationAttemptId: verification.payload.applicationAttemptId!,
                    applicationAuthorityDigest: verification.payload.applicationAuthorityDigest!,
                }
                : undefined;
        if (
            peerApplicationEncryption?.applicationKind === 'agent_realtime'
            && !voiceMediaPeerApplicationEncryptionRegistry.bindAgentRealtimeAttempt({
                authority: peerApplicationEncryption,
                peerApplicationEncryption,
            }).ok
        ) {
            grantReservation.activationFailed();
            emitAbort(tunnelId, 'application_authority_invalid');
            return;
        }

        openingTunnels.add(tunnelId);
        let connection: PeerTcpTunnelTcpConnection | undefined;
        if (verification.payload.flowKind === 'tcp_tunnel') {
            try {
                connection = await options.connectTcp({
                    host: normalizeDestinationHost(open.destination.host),
                    port: open.destination.port,
                });
            } catch {
                // The server has already consumed this relay authorization. The
                // daemon store therefore retains consumption even when local TCP
                // activation fails, rather than making the relay grant reusable.
                grantReservation.activationFailed();
                openingTunnels.delete(tunnelId);
                pendingFramesByOpeningTunnel.delete(tunnelId);
                emitObservability({
                    kind: 'flow.errored',
                    tunnelId,
                    reasonCode: 'tcp_connect_failed',
                    routeGrantId: verification.payload.grantId,
                });
                emitAbort(tunnelId, 'tcp_connect_failed');
                return;
            }
        }
        grantReservation.commit();

        const encoding = selectedOpenEncoding(envelope.frame);
        const binarySessionCaps = encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
            ? {
                maxEncodedFrameBytes: Number.MAX_SAFE_INTEGER,
                maxDecodedPayloadBytes: maxRawPayloadBytes,
                maxSendChunkBytes: maxRawPayloadBytes,
            }
            : {};
        const session = connection
            ? createPeerTcpTunnelStreamSession({
            tunnelId,
            initialWindowBytes: options.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
            maxFrameBytes,
            ...binarySessionCaps,
            maxIdleMs: verification.payload.maxIdleMs,
            maxDurationMs: verification.payload.maxDurationMs,
            maxTotalBytes: verification.payload.maxTotalBytes,
            connection,
            sendFrame: async (frame) => {
                if (frame.kind === 'open') return;
                if (!await recordFrameBytes(frame, verification.payload.maxTotalBytes)) return;
                emitSessionFrame(encoding, frame);
            },
            nowMs: options.nowMs,
            })
            : undefined;
        const resolvedSubstreamCaps = resolveSubstreamCaps({
            configured: options.substreamCaps,
            authorization: verification.payload,
        });
        const substreamMux = verification.payload.flowKind === 'tcp_tunnel'
            && encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
            ? createPeerTcpTunnelSubstreamMuxSession({
                tunnelId,
                destination: {
                    host: normalizeDestinationHost(open.destination.host),
                    port: open.destination.port,
                },
                initialWindowBytes: options.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
                maxFrameBytes,
                maxBinaryHeaderBytes,
                maxRawPayloadBytes,
                caps: resolvedSubstreamCaps,
                connectTcp: options.connectTcp,
                sendBinaryFrame: (frame) => {
                    options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
                        v: 2,
                        scopeUserId: options.accountId,
                        sender: { kind: 'machine', machineId: options.machineId },
                        recipient: { kind: 'user' },
                        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                        frame,
                    });
                },
                nowMs: options.nowMs,
            })
            : undefined;
        const applicationSubstreams = encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
            && verification.payload.flowKind === 'voice_media'
            && (
                (
                    verification.payload.applicationKind === 'speech_transcription'
                    && options.voiceBinaryAppendConsumer
                )
                || (
                    verification.payload.applicationKind === 'agent_realtime'
                    && options.voiceMediaAgentRealtimeConsumer
                )
            )
            ? createPeerTcpTunnelApplicationSubstreamSession({
                tunnelId,
                maxBinaryHeaderBytes,
                maxFrameBytes: verification.payload.maxFrameBytes,
                maxBytesPerSubstream: resolvedSubstreamCaps.maxBytesPerSubstream,
                maxAggregateBytes: resolvedSubstreamCaps.maxAggregateBytes,
                maxConcurrentSubstreams: resolvedSubstreamCaps.maxConcurrentSubstreams,
                maxTotalSubstreams: resolvedSubstreamCaps.maxTotalSubstreams,
                maxSubstreamIdleMs: resolvedSubstreamCaps.maxSubstreamIdleMs,
                maxSessionIdleMs: resolvedSubstreamCaps.maxSessionIdleMs,
                maxDurationMs: verification.payload.maxDurationMs,
                sendBinaryFrame: (frame) => {
                    options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, {
                        v: 2,
                        scopeUserId: options.accountId,
                        sender: { kind: 'machine', machineId: options.machineId },
                        recipient: { kind: 'user' },
                        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                        frame,
                    });
                },
                onTerminal: async ({ reasonCode, substreamIds }) => {
                    try {
                        await dispatchDaemonVoiceInferenceSttTerminal({
                            consumer: options.voiceBinaryTerminalConsumer,
                            substreamIds,
                            reasonCode,
                            peerApplicationEncryption,
                            voiceMediaApplicationAuthority: peerApplicationEncryption,
                        });
                    } finally {
                        await closeTunnel(tunnelId, { skipApplicationSubstreamClose: true });
                    }
                },
                nowMs: options.nowMs,
            })
            : undefined;
        activeTunnels.set(tunnelId, {
            ...(session ? { session } : {}),
            encoding,
            flowKind: verification.payload.flowKind,
            maxFrameBytes: verification.payload.maxFrameBytes,
            maxTotalBytes: verification.payload.maxTotalBytes,
            ...(peerApplicationEncryption ? { peerApplicationEncryption } : {}),
            ...(substreamMux ? { substreamMux } : {}),
            ...(applicationSubstreams ? { applicationSubstreams } : {}),
            ...(applicationSubstreams ? { applicationAbortController: new AbortController() } : {}),
        });
        bytesByTunnelId.set(tunnelId, { in: 0, out: 0 });
        emitObservability({
            kind: 'flow.ready',
            tunnelId,
            flowKind: verification.payload.flowKind,
            routeGrantId: verification.payload.grantId,
            metadata: {
                destinationHost: normalizeDestinationHost(open.destination.host),
                destinationPort: open.destination.port,
                encoding,
            },
        });
        openingTunnels.delete(tunnelId);
        await drainFramesForOpenedTunnel(tunnelId);
    }

    async function handleEnvelope(envelope: PeerTcpTunnelRelayEnvelope): Promise<void> {
        if (envelope.v === 1 && envelope.frame.kind === 'open') {
            await openTunnel(envelope);
            return;
        }

        let tunnelId: string;
        let frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
        if (envelope.v === 1) {
            tunnelId = frameTunnelId(envelope.frame);
            frame = envelope.frame as Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
        } else {
            const routingHeader = decodePeerTcpTunnelBinaryRoutingHeaderV2({
                frame: envelope.frame,
                maxHeaderBytes: maxBinaryHeaderBytes,
            });
            if (routingHeader.ok && routingHeader.header.substreamId) {
                const active = activeTunnels.get(routingHeader.header.tunnelId);
                const voiceSubstream = parseDaemonVoiceInferenceSttSubstreamId(routingHeader.header.substreamId);
                const agentRealtimeSubstream = active?.peerApplicationEncryption?.applicationKind === 'agent_realtime'
                    && routingHeader.header.substreamId
                        === `agent.realtime.${active.peerApplicationEncryption.applicationAttemptId}`;
                if (
                    active
                    && (voiceSubstream || agentRealtimeSubstream)
                    && active.flowKind === 'voice_media'
                    && active.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
                    && active.applicationSubstreams
                    && (
                        (voiceSubstream && options.voiceBinaryAppendConsumer)
                        || (agentRealtimeSubstream && options.voiceMediaAgentRealtimeConsumer)
                    )
                ) {
                    if (envelope.frame.byteLength > maxFramedMessageBytes) {
                        await active.applicationSubstreams.denySubstream(
                            routingHeader.header.substreamId,
                            'encoded_frame_too_large',
                        );
                        return;
                    }
                    const admittedFrame = decodePeerTcpTunnelBinaryFrameV2({
                        frame: envelope.frame,
                        maxHeaderBytes: maxBinaryHeaderBytes,
                        maxPayloadBytes: maxRawPayloadBytes,
                    });
                    if (!admittedFrame.ok) {
                        await active.applicationSubstreams.denySubstream(
                            routingHeader.header.substreamId,
                            peerTcpTunnelBinaryDecodeFailureReason(admittedFrame.reasonCode),
                        );
                        return;
                    }
                    await active.applicationSubstreams.acceptBinaryFrame(envelope.frame, async ({ payload, sequence }) => {
                        if (
                            agentRealtimeSubstream
                            && options.voiceMediaAgentRealtimeConsumer
                            && active.peerApplicationEncryption
                        ) {
                            const handled = await dispatchVoiceMediaAgentRealtimeBinaryFrame({
                                authority: active.peerApplicationEncryption,
                                peerApplicationEncryption: active.peerApplicationEncryption,
                                substreamId: routingHeader.header.substreamId!,
                                carrierSequence: sequence,
                                payload,
                                consumer: options.voiceMediaAgentRealtimeConsumer,
                                emitPayload: async (createPayload) => {
                                    await active.applicationSubstreams!.sendApplicationFrame({
                                        substreamId: routingHeader.header.substreamId!,
                                        createPayload: async (carrierSequence) => {
                                            const response = await createPayload(carrierSequence);
                                            if (!response) {
                                                throw new Error(
                                                    'Agent realtime relay response could not be encrypted',
                                                );
                                            }
                                            return response;
                                        },
                                    });
                                },
                                signal: active.applicationAbortController?.signal
                                    ?? new AbortController().signal,
                            });
                            if (!handled) {
                                throw new Error('Agent realtime relay frame was rejected');
                            }
                            return null;
                        }
                        let responsePayload: Uint8Array | null = null;
                        await dispatchDaemonVoiceInferenceSttBinaryAppend({
                            consumer: options.voiceBinaryAppendConsumer!,
                            header: {
                                ...routingHeader.header,
                                kind: 'data',
                                direction: 'client_to_daemon',
                                sequence,
                            },
                            payload,
                            voiceMediaApplicationAuthority: active.peerApplicationEncryption,
                            ...(active.peerApplicationEncryption ? {
                                peerApplicationEncryption: active.peerApplicationEncryption,
                            } : {}),
                            onResponse: (response) => {
                                responsePayload = encodeVoiceConsumerResponse(response);
                            },
                        });
                        return responsePayload;
                    });
                    return;
                }
            }
            if (envelope.frame.byteLength > maxFramedMessageBytes) {
                return;
            }
            const decodedHeader = decodePeerTcpTunnelBinaryFrameV2({
                frame: envelope.frame,
                maxHeaderBytes: maxBinaryHeaderBytes,
                maxPayloadBytes: maxRawPayloadBytes,
            });
            if (decodedHeader.ok && decodedHeader.header.substreamId) {
                const active = activeTunnels.get(decodedHeader.header.tunnelId);
                if (!active) {
                    if (queueFrameForOpeningTunnel(decodedHeader.header.tunnelId, envelope)) return;
                    emitObservability({
                        kind: 'flow.denied',
                        tunnelId: decodedHeader.header.tunnelId,
                        reasonCode: 'tunnel_not_open',
                    });
                    emitAbort(decodedHeader.header.tunnelId, 'tunnel_not_open');
                    return;
                }
                if (active.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 || !active.substreamMux) {
                    emitObservability({
                        kind: 'flow.denied',
                        tunnelId: decodedHeader.header.tunnelId,
                        reasonCode: 'encoding_unsupported',
                    });
                    emitAbort(decodedHeader.header.tunnelId, 'encoding_unsupported');
                    return;
                }
                if (await rejectIfSignedFrameCapExceeded({
                    active,
                    tunnelId: decodedHeader.header.tunnelId,
                    payloadBytes: decodedHeader.payload.byteLength,
                })) {
                    return;
                }
                const voiceSubstream = parseDaemonVoiceInferenceSttSubstreamId(decodedHeader.header.substreamId);
                const agentRealtimeSubstream =
                    active.peerApplicationEncryption?.applicationKind === 'agent_realtime'
                    && decodedHeader.header.substreamId
                        === `agent.realtime.${active.peerApplicationEncryption.applicationAttemptId}`;
                if (await rejectIfVoiceRelayCarriesGenericFrame({
                    active,
                    tunnelId: decodedHeader.header.tunnelId,
                    allowed: active.flowKind === 'voice_media'
                        ? voiceSubstream !== null || agentRealtimeSubstream
                        : voiceSubstream === null && !agentRealtimeSubstream,
                })) {
                    return;
                }
                if (voiceSubstream || agentRealtimeSubstream) {
                    if (
                        active.applicationSubstreams
                        && (
                            (voiceSubstream && options.voiceBinaryAppendConsumer)
                            || (agentRealtimeSubstream && options.voiceMediaAgentRealtimeConsumer)
                        )
                    ) {
                        await active.applicationSubstreams.acceptBinaryFrame(envelope.frame, async ({ payload, sequence }) => {
                            if (
                                agentRealtimeSubstream
                                && options.voiceMediaAgentRealtimeConsumer
                                && active.peerApplicationEncryption
                            ) {
                                const handled = await dispatchVoiceMediaAgentRealtimeBinaryFrame({
                                    authority: active.peerApplicationEncryption,
                                    peerApplicationEncryption: active.peerApplicationEncryption,
                                    substreamId: decodedHeader.header.substreamId!,
                                    carrierSequence: sequence,
                                    payload,
                                    consumer: options.voiceMediaAgentRealtimeConsumer,
                                    emitPayload: async (createPayload) => {
                                        await active.applicationSubstreams!.sendApplicationFrame({
                                            substreamId: decodedHeader.header.substreamId!,
                                            createPayload: async (carrierSequence) => {
                                                const response = await createPayload(carrierSequence);
                                                if (!response) {
                                                    throw new Error(
                                                        'Agent realtime relay response could not be encrypted',
                                                    );
                                                }
                                                return response;
                                            },
                                        });
                                    },
                                    signal: active.applicationAbortController?.signal
                                        ?? new AbortController().signal,
                                });
                                if (!handled) {
                                    throw new Error('Agent realtime relay frame was rejected');
                                }
                                return null;
                            }
                            let responsePayload: Uint8Array | null = null;
                            await dispatchDaemonVoiceInferenceSttBinaryAppend({
                                consumer: options.voiceBinaryAppendConsumer,
                                header: {
                                    ...decodedHeader.header,
                                    kind: 'data',
                                    direction: 'client_to_daemon',
                                    sequence,
                                },
                                payload,
                                voiceMediaApplicationAuthority: active.peerApplicationEncryption,
                                ...(active.peerApplicationEncryption ? {
                                    peerApplicationEncryption: active.peerApplicationEncryption,
                                } : {}),
                                onResponse: (response) => {
                                    responsePayload = encodeVoiceConsumerResponse(response);
                                },
                            });
                            return responsePayload;
                        });
                        return;
                    }
                    if (await rejectIfVoiceRelayCarriesGenericFrame({
                        active,
                        tunnelId: decodedHeader.header.tunnelId,
                        allowed: false,
                    })) {
                        return;
                    }
                }
                await active.substreamMux.acceptBinaryFrame(envelope.frame);
                return;
            }
            const decoded = decodePeerTcpTunnelBinaryFrameForSession({
                frame: envelope.frame,
                maxBinaryHeaderBytes,
                maxRawPayloadBytes,
            });
            if (!decoded.ok) return;
            tunnelId = decoded.frame.tunnelId;
            frame = decoded.frame;
        }

        const active = activeTunnels.get(tunnelId);
        if (!active) {
            if (queueFrameForOpeningTunnel(tunnelId, envelope)) return;
            if (isTerminalFrame(frame)) return;
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'tunnel_not_open',
            });
            emitAbort(tunnelId, 'tunnel_not_open');
            return;
        }
        if (envelope.v === 2 && active.encoding !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2) {
            emitObservability({
                kind: 'flow.denied',
                tunnelId,
                reasonCode: 'encoding_unsupported',
            });
            emitAbort(tunnelId, 'encoding_unsupported');
            return;
        }
        if (await rejectIfVoiceRelayCarriesGenericFrame({
            active,
            tunnelId,
            allowed: active.flowKind !== 'voice_media' || isTerminalFrame(frame),
        })) {
            return;
        }
        if (await rejectIfSignedFrameCapExceeded({
            active,
            tunnelId,
            payloadBytes: dataFrameBytes(frame),
        })) {
            return;
        }
        if (!await recordFrameBytes(frame, active.maxTotalBytes)) return;
        if (!active.session) {
            await denyActiveTunnelFrame({ tunnelId, reasonCode: 'voice_relay_frame_not_allowed' });
            return;
        }
        await active.session.acceptFrame(frame);
        if (isTerminalFrame(frame)) {
            await closeTunnel(tunnelId);
        }
    }

    options.socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, async (raw: unknown) => {
        const parsed = PeerTcpTunnelRelayEnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
            const tunnelId = readInvalidRelayAuthorizationOpenTunnelId({
                raw,
                accountId: options.accountId,
                machineId: options.machineId,
            });
            if (tunnelId) {
                emitObservability({
                    kind: 'flow.denied',
                    tunnelId,
                    reasonCode: 'relay_authorization_invalid',
                });
                emitAbort(tunnelId, 'relay_authorization_invalid');
            }
            return;
        }

        await handleEnvelope(parsed.data);
    });
}
