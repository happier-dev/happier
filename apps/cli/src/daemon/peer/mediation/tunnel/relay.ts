import { PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES, PEER_TCP_TUNNEL_DEFAULT_MAX_FRAME_BYTES } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, PeerTcpTunnelRelayEnvelopeSchema } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { decodePeerTcpTunnelBinaryFrameHeaderV2, decodePeerTcpTunnelBinaryFrameV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v2';
import { verifyPeerTcpTunnelRelayAuthorizationV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/authorization';
import { createPeerApplicationAuthorityDigestV1 } from '@happier-dev/protocol/machines/peer/mediation/peerApplicationEncryptionV1';
import type { PeerTcpTunnelSubstreamCapsV2, PeerTcpTunnelEncoding, PeerTcpTunnelFrameV1, PeerTcpTunnelOpenV1, PeerTcpTunnelRelayAuthorizationPayloadV2, PeerTcpTunnelRelayAuthorizationV2, PeerTcpTunnelRelayAuthorizationTrustRootV1, PeerTcpTunnelRelayBinaryEnvelopeV2, PeerTcpTunnelRelayEnvelope, PeerTcpTunnelRelayEnvelopeV1, PeerApplicationEncryptionAuthorityBindingV1, ProviderBrokerRelayApplicationBindingV1 } from '@happier-dev/protocol';

import {
    createPeerTcpTunnelApplicationSubstreamSession,
    createPeerTcpTunnelSubstreamMuxSession,
    createPeerTcpTunnelStreamSession,
    decodePeerTcpTunnelBinaryFrameForSession,
    encodePeerTcpTunnelBinaryFrameForSession,
    peerTcpTunnelBinaryDecodeFailureReason,
    type PeerTcpTunnelFrame,
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
import { createAtomicRouteGrantConsumption } from './grantConsumption';
import { isFirstBytesLocalCapability } from '../loopback/firstBytesLocalCapability';

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
    resolveProviderBrokerApplicationTarget?: (input: Readonly<{
        binding: ProviderBrokerRelayApplicationBindingV1;
        relayAuthorization: PeerTcpTunnelRelayAuthorizationV2;
    }>) => Promise<Readonly<{ port: number; localCapability: string }> | null>;
    initialWindowBytes?: number;
    maxFrameBytes?: number;
    maxBinaryHeaderBytes?: number;
    maxRawPayloadBytes?: number;
    maxFramedMessageBytes?: number;
    maxActiveTunnels?: number;
    substreamCaps?: PeerTcpTunnelSubstreamCapsV2;
    observability?: DaemonPeerMediationObservabilityEmitter;
    voiceBinaryAppendConsumer?: PeerTcpTunnelVoiceBinaryAppendConsumer;
    voiceBinaryTerminalConsumer?: PeerTcpTunnelVoiceBinaryTerminalConsumer;
}>;

function normalizeDestinationHost(host: string): string {
    const trimmed = host.trim().toLowerCase();
    return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function validateRelayAuthorizationBinding(input: Readonly<{
    open: PeerTcpTunnelOpenV1;
    payload: PeerTcpTunnelRelayAuthorizationPayloadV2;
}>): boolean {
    if (input.payload.routeKind !== input.open.routeKind
        || input.payload.tunnelId !== input.open.tunnelId
        || input.payload.targetMachineId !== input.open.targetMachineId) return false;
    if (input.payload.flowKind === 'provider_broker') {
        return input.payload.providerBroker !== undefined && input.open.destination === undefined;
    }
    return input.payload.destination !== undefined
        && input.open.destination !== undefined
        && normalizeDestinationHost(input.payload.destination.host) === normalizeDestinationHost(input.open.destination.host)
        && input.payload.destination.port === input.open.destination.port;
}

function frameTunnelId(frame: PeerTcpTunnelFrameV1): string {
    return frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
}

function selectedOpenEncoding(frame: PeerTcpTunnelFrameV1): PeerTcpTunnelEncoding {
    return frame.kind === 'open'
        ? frame.open.selectedEncoding ?? PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
        : PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2;
}

type SessionFrame = PeerTcpTunnelFrame;

function dataFrameBytes(frame: SessionFrame): number {
    if (frame.kind !== 'data') return 0;
    return frame.payload.byteLength;
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
    frame: PeerTcpTunnelFrame;
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
    configured: PeerTcpTunnelSubstreamCapsV2 | undefined;
    authorization: PeerTcpTunnelRelayAuthorizationPayloadV2;
}>): PeerTcpTunnelSubstreamCapsV2 {
    const maxConcurrentSubstreams = input.configured?.maxConcurrentSubstreams
        ?? DEFAULT_MACHINE_TUNNEL_SUBSTREAM_CAPABILITIES.maxConcurrentSubstreams;
    if (input.authorization.flowKind === 'tcp_tunnel') {
        return { maxConcurrentSubstreams };
    }
    return {
        maxConcurrentSubstreams,
        maxBytesPerSubstream: input.authorization.maxTotalBytes,
        maxAggregateBytes: input.authorization.maxTotalBytes,
        maxSubstreamIdleMs: input.authorization.maxIdleMs,
        maxSessionIdleMs: input.authorization.maxIdleMs,
    };
}

export function registerPeerTcpTunnelRelayTerminator(
    options: RegisterPeerTcpTunnelRelayTerminatorOptions,
): Readonly<{ dispose(): Promise<void> }> {
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
    let disposed = false;

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
        const flowKind = input.flowKind
            ?? activeTunnels.get(input.tunnelId)?.flowKind
            ?? 'tcp_tunnel';
        // Provider broker has its own resource/usage audit owner and is not a
        // member of the generic peer-flow observability wire enum.
        if (flowKind === 'provider_broker') return;
        options.observability?.emit(createDaemonPeerMediationFlowEvent({
            accountId: options.accountId,
            machineId: options.machineId,
            flowKind,
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
        frame: SessionFrame,
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

    function emitBinarySessionFrame(frame: PeerTcpTunnelFrame): void {
        options.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, buildBinaryEnvelope({
            accountId: options.accountId,
            machineId: options.machineId,
            frame,
        }));
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

    function isTerminalFrame(frame: SessionFrame): boolean {
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
        if (disposed) return;
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

        const relayAuthorization = open.relayAuthorization;
        const verification = verifyPeerTcpTunnelRelayAuthorizationV2({
            authorization: relayAuthorization,
            nowMs: options.nowMs(),
            trustRoots: options.relayAuthorizationTrustRoots,
        });
        if (
            !relayAuthorization
            || !verification.valid
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
        let grantReservation: ReturnType<typeof grantConsumption.reserve> = null;
        let providerBrokerTarget: Readonly<{ port: number; localCapability: string }> | null = null;
        if (verification.payload.flowKind === 'provider_broker') {
            grantReservation = grantConsumption.reserve({
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
            try {
                providerBrokerTarget = verification.payload.providerBroker
                    ? await options.resolveProviderBrokerApplicationTarget?.({
                        binding: verification.payload.providerBroker,
                        relayAuthorization,
                    }) ?? null
                    : null;
            } catch {
                providerBrokerTarget = null;
            }
            if (
                !providerBrokerTarget
                || !Number.isInteger(providerBrokerTarget.port)
                || providerBrokerTarget.port < 1
                || providerBrokerTarget.port > 65_535
                || !isFirstBytesLocalCapability(providerBrokerTarget.localCapability)
            ) {
                grantReservation.activationFailed();
                emitObservability({
                    kind: 'flow.denied',
                    tunnelId,
                    reasonCode: 'provider_broker_application_unavailable',
                    routeGrantId: verification.payload.grantId,
                });
                emitAbort(tunnelId, 'provider_broker_application_unavailable');
                return;
            }
        } else if (!open.destination || !isPeerTcpTunnelLoopbackDestinationHost(open.destination.host)) {
            emitObservability({
                kind: 'policy.denied',
                tunnelId,
                reasonCode: 'destination_host_not_allowed',
                routeGrantId: verification.payload.grantId,
                metadata: open.destination
                    ? { destinationHost: open.destination.host, destinationPort: open.destination.port }
                    : undefined,
            });
            emitAbort(tunnelId, 'destination_host_not_allowed');
            return;
        }
        grantReservation ??= grantConsumption.reserve({
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
        openingTunnels.add(tunnelId);
        let connection: PeerTcpTunnelTcpConnection | undefined;
        if (providerBrokerTarget) {
            try {
                connection = await options.connectTcp({
                    host: providerBrokerTarget ? '127.0.0.1' : normalizeDestinationHost(open.destination!.host),
                    port: providerBrokerTarget?.port ?? open.destination!.port,
                });
                if (providerBrokerTarget) {
                    if (!connection.write) throw new Error('provider_broker_capability_write_unavailable');
                    await connection.write(Buffer.from(providerBrokerTarget.localCapability, 'ascii'));
                }
            } catch {
                // The server has already consumed this relay authorization. The
                // daemon store therefore retains consumption even when local TCP
                // activation fails, rather than making the relay grant reusable.
                grantReservation.activationFailed();
                await connection?.close();
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
        if (disposed) {
            grantReservation.activationFailed();
            openingTunnels.delete(tunnelId);
            pendingFramesByOpeningTunnel.delete(tunnelId);
            await connection?.close();
            return;
        }
        grantReservation.commit();

        const encoding = selectedOpenEncoding(envelope.frame);
        const commonSessionInput = connection
            ? {
                tunnelId,
                initialWindowBytes: options.initialWindowBytes ?? PEER_TCP_TUNNEL_DEFAULT_INITIAL_WINDOW_BYTES,
                maxFrameBytes,
                maxIdleMs: verification.payload.maxIdleMs,
                maxDurationMs: verification.payload.maxDurationMs,
                maxTotalBytes: verification.payload.maxTotalBytes,
                connection,
                nowMs: options.nowMs,
            }
            : null;
        const session = !commonSessionInput
            ? undefined
            : createPeerTcpTunnelStreamSession({
                    ...commonSessionInput,
                    maxDecodedPayloadBytes: maxRawPayloadBytes,
                    maxSendChunkBytes: maxRawPayloadBytes,
                    sendFrame: async (frame) => {
                        if (!await recordFrameBytes(frame, verification.payload.maxTotalBytes)) return;
                        emitBinarySessionFrame(frame);
                    },
                    onClosed: () => { void closeTunnel(tunnelId); },
                });
        const resolvedSubstreamCaps = resolveSubstreamCaps({
            configured: options.substreamCaps,
            authorization: verification.payload,
        });
        const substreamMux = verification.payload.flowKind === 'tcp_tunnel'
            && encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
            && open.destination
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
            && verification.payload.applicationKind === 'speech_transcription'
            && options.voiceBinaryAppendConsumer
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
        });
        bytesByTunnelId.set(tunnelId, { in: 0, out: 0 });
        emitObservability({
            kind: 'flow.ready',
            tunnelId,
            flowKind: verification.payload.flowKind,
            routeGrantId: verification.payload.grantId,
            metadata: {
                ...(open.destination ? {
                    destinationHost: normalizeDestinationHost(open.destination.host),
                    destinationPort: open.destination.port,
                } : {}),
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
        let frame: SessionFrame;
        if (envelope.v === 1) {
            // Open negotiation remains a V1 envelope and relay disconnects may
            // still deliver its terminal mate in that envelope. Accept only
            // terminal control here; application data is binary-frame V2.
            if (!isTerminalFrame(envelope.frame as Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>)) {
                emitAbort(frameTunnelId(envelope.frame), 'encoding_unsupported');
                return;
            }
            tunnelId = frameTunnelId(envelope.frame);
            frame = envelope.frame as SessionFrame;
        } else {
            const routingHeader = decodePeerTcpTunnelBinaryFrameHeaderV2({
                frame: envelope.frame,
                maxHeaderBytes: maxBinaryHeaderBytes,
            });
            if (routingHeader.ok && routingHeader.header.substreamId) {
                const active = activeTunnels.get(routingHeader.header.tunnelId);
                const voiceSubstream = parseDaemonVoiceInferenceSttSubstreamId(routingHeader.header.substreamId);
                if (
                    active
                    && voiceSubstream
                    && active.flowKind === 'voice_media'
                    && active.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
                    && active.applicationSubstreams
                    && options.voiceBinaryAppendConsumer
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
                if (await rejectIfVoiceRelayCarriesGenericFrame({
                    active,
                    tunnelId: decodedHeader.header.tunnelId,
                    allowed: active.flowKind === 'voice_media'
                        ? voiceSubstream !== null
                        : voiceSubstream === null,
                })) {
                    return;
                }
                if (voiceSubstream) {
                    if (active.applicationSubstreams && options.voiceBinaryAppendConsumer) {
                        await active.applicationSubstreams.acceptBinaryFrame(envelope.frame, async ({ payload, sequence }) => {
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
        if (frame.kind === 'abort' || (frame.kind === 'close' && !frame.halfClose)) {
            await closeTunnel(tunnelId);
            return;
        }
        if (!active.session) {
            if (active.substreamMux) {
                await denyActiveTunnelFrame({ tunnelId, reasonCode: 'encoding_unsupported' });
                return;
            }
            await denyActiveTunnelFrame({ tunnelId, reasonCode: 'voice_relay_frame_not_allowed' });
            return;
        }
        await active.session.acceptFrame(frame);
    }

    options.socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, async (raw: unknown) => {
        if (disposed) return;
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

    return Object.freeze({
        dispose: async () => {
            if (disposed) return;
            disposed = true;
            await Promise.all([...activeTunnels.keys()].map(async (tunnelId) => await closeTunnel(tunnelId)));
            openingTunnels.clear();
            pendingFramesByOpeningTunnel.clear();
            bytesByTunnelId.clear();
        },
    });
}
