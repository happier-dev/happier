import {
    decodePeerApplicationEncryptedFrameV1,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PEER_TCP_TUNNEL_MAX_WINDOW_BYTES,
    PeerTcpTunnelRelayEnvelopeSchema,
    PeerTcpTunnelRelayEnvelopeV1Schema,
    isLiteralLoopbackHostname,
    normalizeHostnameForLoopbackCheck,
    verifyPeerTcpTunnelRelayAuthorizationV2,
    type PeerTcpTunnelBinaryFrameHeaderV2,
    type PeerTcpTunnelEncoding,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelRelayBinaryEnvelopeV2,
    type PeerTcpTunnelRelayEnvelope,
    type PeerTcpTunnelRelayEnvelopeV1,
    type PeerTcpTunnelRelayAuthorizationPayloadV2,
    type PeerTcpTunnelRelayAuthorizationTrustRootV1,
    type PeerTcpTunnelRelayParticipantV1,
    type PeerTcpTunnelOpenV1,
} from '@happier-dev/protocol';

import { getSocketRooms } from '../../../../socketRooms';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { resolvePeerTcpTunnelRelayCaps, type PeerTcpTunnelRelayCaps } from './relayCaps';
import {
    createPeerMediationFlowEvent,
    type PeerMediationObservabilityEmitter,
    type PeerMediationObservabilityFlowKind,
} from '../observability/events';
import type {
    PeerTcpTunnelRelayAdmissionResult,
    PeerTcpTunnelRelayCoordinator,
} from './relayCoordinator';

type TunnelRelaySocket = Readonly<{
    id?: string;
    data?: Record<string, unknown>;
    on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => unknown;
    emit: (event: string, payload: unknown) => unknown;
}>;

type TunnelRelayIo = Readonly<{
    to: (room: string) => Readonly<{ emit: (event: string, payload: unknown) => unknown }>;
    local: Readonly<{
        to: (room: string) => Readonly<{ emit: (event: string, payload: unknown) => unknown }>;
    }>;
}>;

type TunnelKey = string;

type RelayMeteringCaps = Readonly<{
    maxBytes?: number;
    maxFrameBytes: number;
    maxIdleMs?: number;
    maxDurationMs?: number;
}>;

type AuthorizedRelayState = Readonly<{
    flowKind: PeerTcpTunnelRelayAuthorizationPayloadV2['flowKind'];
    meteringCaps: RelayMeteringCaps;
    installationId?: string;
}>;

const registeredSockets = new WeakSet<object>();
const activeTunnelKeysBySocket = new WeakMap<object, Set<TunnelKey>>();
const socketSetsByTunnelKey = new Map<TunnelKey, Set<Set<TunnelKey>>>();
const authorizedTunnelKeys = new Set<TunnelKey>();
const bytesByTunnelKey = new Map<TunnelKey, Readonly<{ in: number; out: number }>>();
const encodingByTunnelKey = new Map<TunnelKey, PeerTcpTunnelEncoding>();
const authorizationStateByTunnelKey = new Map<TunnelKey, AuthorizedRelayState>();
const voiceApplicationProtectionByTunnelKey = new Map<TunnelKey, {
    encryptedApplicationFrames: number;
    unprotectedApplicationFrames: number;
}>();
const observabilityIdentityByTunnelKey = new Map<TunnelKey, {
    tunnelId: string;
    machineId?: string;
}>();
const userSocketIdByTunnelKey = new Map<TunnelKey, string>();
const tunnelStartedAtByKey = new Map<TunnelKey, number>();
const tunnelLastActivityAtByKey = new Map<TunnelKey, number>();
const substreamsByTunnelKey = new Map<TunnelKey, Set<string>>();
const tunnelTimersByKey = new Map<TunnelKey, Readonly<{
    idleTimer?: ReturnType<typeof setTimeout>;
    durationTimer?: ReturnType<typeof setTimeout>;
}>>();
const coordinatorByTunnelKey = new Map<TunnelKey, PeerTcpTunnelRelayCoordinator>();

function getFrameTunnelId(frame: PeerTcpTunnelFrameV1): string {
    return frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
}

function getEnvelopeTunnelId(envelope: PeerTcpTunnelRelayEnvelope, header?: PeerTcpTunnelBinaryFrameHeaderV2): string {
    return envelope.v === 1 ? getFrameTunnelId(envelope.frame) : header?.tunnelId ?? '';
}

function machineRoom(userId: string, machineId: string): string {
    const rooms = getSocketRooms({
        userId,
        clientType: 'machine-scoped',
        machineId,
    });
    return rooms.find((room) => room.startsWith(`machine:${machineId}:`)) ?? `machine:${machineId}:${userId}`;
}

function participantRoom(input: Readonly<{
    userId: string;
    participant: PeerTcpTunnelRelayParticipantV1;
    tunnelKey?: TunnelKey;
    boundUserSocketId?: string;
}>): string {
    const { userId, participant, tunnelKey, boundUserSocketId } = input;
    if (participant.kind === 'machine') {
        return machineRoom(userId, participant.machineId);
    }
    if (participant.socketId) return participant.socketId;
    if (boundUserSocketId) return boundUserSocketId;
    if (tunnelKey) {
        const tunnelUserSocketId = userSocketIdByTunnelKey.get(tunnelKey);
        if (tunnelUserSocketId) return tunnelUserSocketId;
    }
    return getSocketRooms({
        userId,
        clientType: 'user-scoped',
    })[0] ?? `user:${userId}`;
}

function participantKey(participant: PeerTcpTunnelRelayParticipantV1): string {
    return participant.kind === 'machine' ? `machine:${participant.machineId}` : 'user';
}

function participantMachineId(envelope: PeerTcpTunnelRelayEnvelope): string | undefined {
    if (envelope.sender.kind === 'machine') return envelope.sender.machineId;
    if (envelope.recipient.kind === 'machine') return envelope.recipient.machineId;
    return undefined;
}

function validateOpenFramePolicy(input: Readonly<{
    envelope: PeerTcpTunnelRelayEnvelopeV1;
    caps: PeerTcpTunnelRelayCaps;
}>): string | null {
    const frame = input.envelope.frame;
    if (frame.kind !== 'open') return null;
    if (frame.open.routeKind !== 'server_relay') return 'route_unavailable';
    if (input.envelope.recipient.kind !== 'machine' || frame.open.targetMachineId !== input.envelope.recipient.machineId) {
        return 'probe_binding_mismatch';
    }
    if (frame.open.relayAuthorization?.payload.flowKind === 'provider_broker') {
        return frame.open.destination === undefined ? null : 'destination_host_not_allowed';
    }
    if (!frame.open.destination || !isLiteralLoopbackHostname(frame.open.destination.host)) return 'destination_host_not_allowed';
    if (frame.open.relayAuthorization?.payload.flowKind !== 'voice_media'
        && !input.caps.allowedPorts.includes(frame.open.destination.port)) return 'destination_port_not_allowed';
    return null;
}

function validateRelayAuthorizationBinding(input: Readonly<{
    open: PeerTcpTunnelOpenV1;
    payload: PeerTcpTunnelRelayAuthorizationPayloadV2;
}>): string | null {
    if (input.payload.routeKind !== input.open.routeKind) return 'relay_authorization_invalid';
    if (input.payload.tunnelId !== input.open.tunnelId) return 'relay_authorization_invalid';
    if (input.payload.targetMachineId !== input.open.targetMachineId) return 'relay_authorization_invalid';
    if (input.payload.flowKind === 'provider_broker') {
        return input.payload.providerBroker && input.open.destination === undefined
            ? null
            : 'relay_authorization_invalid';
    }
    if (!input.payload.destination || !input.open.destination) return 'relay_authorization_invalid';
    if (
        normalizeHostnameForLoopbackCheck(input.payload.destination.host)
        !== normalizeHostnameForLoopbackCheck(input.open.destination.host)
    ) {
        return 'relay_authorization_invalid';
    }
    if (input.payload.destination.port !== input.open.destination.port) return 'relay_authorization_invalid';
    return null;
}

function validateRelayAuthorization(input: Readonly<{
    envelope: PeerTcpTunnelRelayEnvelopeV1;
    relaySocketId: string | undefined;
    nowMs: number;
    trustRoots: readonly PeerTcpTunnelRelayAuthorizationTrustRootV1[] | undefined;
}>): PeerTcpTunnelRelayAuthorizationPayloadV2 | null {
    const frame = input.envelope.frame;
    if (frame.kind !== 'open') return null;

    const authorization = frame.open.relayAuthorization;
    if (authorization === undefined) return null;
    if (input.trustRoots === undefined || input.trustRoots.length === 0) {
        return null;
    }

    const payload = authorization.payload;
    if (payload.accountId !== input.envelope.scopeUserId) return null;
    const verification = verifyPeerTcpTunnelRelayAuthorizationV2({
        authorization,
        nowMs: input.nowMs,
        trustRoots: input.trustRoots,
    });
    if (!verification.valid) return null;
    if (
        input.relaySocketId !== verification.payload.relaySocketId
        || input.envelope.sender.kind !== 'user'
        || input.envelope.sender.socketId !== verification.payload.relaySocketId
    ) {
        return null;
    }
    if (validateRelayAuthorizationBinding({ open: frame.open, payload: verification.payload })) return null;
    return verification.payload;
}

function emitSocketError(socket: TunnelRelaySocket, error: string): void {
    socket.emit('error', {
        type: 'peer-tunnel',
        error,
    });
}

function buildTunnelKey(envelope: PeerTcpTunnelRelayEnvelope, tunnelId: string): TunnelKey {
    const participants = [participantKey(envelope.sender), participantKey(envelope.recipient)].sort();
    return `${envelope.scopeUserId}:${participants[0]}:${participants[1]}:${tunnelId}`;
}

function senderMatchesSocket(socket: TunnelRelaySocket, sender: PeerTcpTunnelRelayParticipantV1): boolean {
    const clientType = socket.data?.clientType;
    if (sender.kind === 'machine') {
        return clientType === 'machine-scoped' && socket.data?.machineId === sender.machineId;
    }
    return (clientType === 'user-scoped' || clientType === 'session-scoped')
        && (sender.socketId === undefined || sender.socketId === socket.id);
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readRawParticipant(value: unknown): PeerTcpTunnelRelayParticipantV1 | null {
    const record = readRecord(value);
    if (!record) return null;
    if (record.kind === 'user') return { kind: 'user' };
    if (record.kind === 'machine' && typeof record.machineId === 'string' && record.machineId.length > 0) {
        return { kind: 'machine', machineId: record.machineId };
    }
    return null;
}

function readInvalidRelayAuthorizationOpenAbortEnvelope(raw: unknown, userId: string): Readonly<{
    envelope: PeerTcpTunnelRelayEnvelopeV1;
    tunnelId: string;
    reasonCode: 'relay_authorization_invalid';
}> | null {
    const envelope = readRecord(raw);
    if (!envelope || envelope.v !== 1 || envelope.scopeUserId !== userId) return null;
    const sender = readRawParticipant(envelope.sender);
    const recipient = readRawParticipant(envelope.recipient);
    const frame = readRecord(envelope.frame);
    const open = readRecord(frame?.open);
    if (!sender || !recipient || frame?.kind !== 'open' || open?.kind !== 'open') return null;
    if (open.routeKind !== 'server_relay' || readRecord(open.relayAuthorization) === null) return null;
    if (typeof open.tunnelId !== 'string' || open.tunnelId.length === 0) return null;

    return {
        envelope: {
            v: 1,
            scopeUserId: userId,
            sender,
            recipient,
            frame: {
                v: 1,
                kind: 'abort',
                tunnelId: open.tunnelId,
                reasonCode: 'relay_authorization_invalid',
            },
        },
        tunnelId: open.tunnelId,
        reasonCode: 'relay_authorization_invalid',
    };
}

/**
 * Machine delivery is owned by the cluster coordinator: it holds the exact
 * attached machine socket, which may live on another replica. User delivery
 * stays local because the owner socket is, by construction, on this replica.
 */
function emitEnvelopeToParticipant(input: Readonly<{
    io: TunnelRelayIo;
    userId: string;
    participant: PeerTcpTunnelRelayParticipantV1;
    envelope: PeerTcpTunnelRelayEnvelope;
    tunnelKey?: TunnelKey;
    boundUserSocketId?: string;
    notifyAttachedMachine: boolean;
}>): void {
    if (input.participant.kind === 'machine') {
        if (input.notifyAttachedMachine && input.tunnelKey) {
            coordinatorByTunnelKey.get(input.tunnelKey)?.routeOwnerEnvelope({
                tunnelKey: input.tunnelKey,
                envelope: input.envelope,
            });
        }
        return;
    }
    const room = participantRoom({
        userId: input.userId,
        participant: input.participant,
        tunnelKey: input.tunnelKey,
        boundUserSocketId: input.boundUserSocketId,
    });
    input.io.local.to(room).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, input.envelope);
}

function emitAbortToRelayParticipants(input: Readonly<{
    io: TunnelRelayIo;
    userId: string;
    envelope: PeerTcpTunnelRelayEnvelope;
    tunnelId?: string;
    reasonCode: string;
    tunnelKey?: TunnelKey;
    senderSocketId?: string;
    notifyAttachedMachine: boolean;
}>): void {
    const tunnelId = input.tunnelId ?? getEnvelopeTunnelId(input.envelope);
    if (!tunnelId) return;
    const payload: PeerTcpTunnelRelayEnvelopeV1 = {
        v: 1,
        scopeUserId: input.userId,
        sender: input.envelope.sender,
        recipient: input.envelope.recipient,
        frame: {
            v: 1,
            kind: 'abort',
            tunnelId,
            reasonCode: input.reasonCode,
        },
    };
    emitEnvelopeToParticipant({
        io: input.io,
        userId: input.userId,
        participant: input.envelope.recipient,
        tunnelKey: input.tunnelKey,
        envelope: payload,
        notifyAttachedMachine: input.notifyAttachedMachine,
    });
    emitEnvelopeToParticipant({
        io: input.io,
        userId: input.userId,
        participant: input.envelope.sender,
        tunnelKey: input.tunnelKey,
        boundUserSocketId: input.envelope.sender.kind === 'user' ? input.senderSocketId : undefined,
        envelope: payload,
        notifyAttachedMachine: input.notifyAttachedMachine,
    });
}

function emitBinarySubstreamAbortToRelayParticipants(input: Readonly<{
    io: TunnelRelayIo;
    userId: string;
    envelope: PeerTcpTunnelRelayBinaryEnvelopeV2;
    tunnelId: string;
    substreamId: string;
    reasonCode: string;
    tunnelKey?: TunnelKey;
    senderSocketId?: string;
    notifyAttachedMachine: boolean;
}>): void {
    const payload: PeerTcpTunnelRelayBinaryEnvelopeV2 = {
        v: 2,
        scopeUserId: input.userId,
        sender: input.envelope.sender,
        recipient: input.envelope.recipient,
        encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
        frame: encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'abort',
                tunnelId: input.tunnelId,
                substreamId: input.substreamId,
                reasonCode: input.reasonCode,
                payloadLength: 0,
            },
        }),
    };
    emitEnvelopeToParticipant({
        io: input.io,
        userId: input.userId,
        participant: input.envelope.recipient,
        tunnelKey: input.tunnelKey,
        envelope: payload,
        notifyAttachedMachine: input.notifyAttachedMachine,
    });
    emitEnvelopeToParticipant({
        io: input.io,
        userId: input.userId,
        participant: input.envelope.sender,
        tunnelKey: input.tunnelKey,
        boundUserSocketId: input.envelope.sender.kind === 'user' ? input.senderSocketId : undefined,
        envelope: payload,
        notifyAttachedMachine: input.notifyAttachedMachine,
    });
}

function resolveEffectiveRelayMeteringCaps(
    caps: PeerTcpTunnelRelayCaps,
    authorization: PeerTcpTunnelRelayAuthorizationPayloadV2,
): RelayMeteringCaps {
    // Frames obey both process resources and signed authority. Lifetime/byte
    // budgets belong only to the signed application, never a TCP relay default.
    return {
        maxBytes: authorization.maxTotalBytes,
        maxFrameBytes: Math.min(caps.maxFrameBytes, authorization.maxFrameBytes),
        maxIdleMs: authorization.maxIdleMs,
        maxDurationMs: authorization.maxDurationMs,
    };
}

function selectedOpenEncoding(frame: PeerTcpTunnelFrameV1): PeerTcpTunnelEncoding {
    return frame.kind === 'open'
        ? frame.open.selectedEncoding ?? PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
        : PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2;
}

function validateSelectedOpenEncoding(input: Readonly<{
    frame: PeerTcpTunnelFrameV1;
    caps: PeerTcpTunnelRelayCaps;
}>): string | null {
    if (input.frame.kind !== 'open') return null;
    const selectedEncoding = selectedOpenEncoding(input.frame);
    if (!input.caps.supportedEncodings.includes(selectedEncoding)) return 'encoding_unsupported';
    return null;
}

function decodeBinaryEnvelope(input: Readonly<{
    envelope: PeerTcpTunnelRelayBinaryEnvelopeV2;
    caps: PeerTcpTunnelRelayCaps;
}>): Readonly<{
    ok: true;
    header: PeerTcpTunnelBinaryFrameHeaderV2;
    payload: Uint8Array;
    payloadBytes: number;
}> | Readonly<{
    ok: false;
    reasonCode: 'frame_invalid' | 'relay_cap_exceeded';
    tunnelId?: string;
}> {
    if (input.envelope.frame.byteLength > input.caps.maxFramedMessageBytes) {
        const decoded = decodePeerTcpTunnelBinaryFrameV2({
            frame: input.envelope.frame,
            maxHeaderBytes: input.caps.maxBinaryHeaderBytes,
            maxPayloadBytes: input.caps.maxRawPayloadBytes,
        });
        return {
            ok: false,
            reasonCode: 'relay_cap_exceeded',
            ...(decoded.ok ? { tunnelId: decoded.header.tunnelId } : {}),
        };
    }
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
        frame: input.envelope.frame,
        maxHeaderBytes: input.caps.maxBinaryHeaderBytes,
        maxPayloadBytes: Number.MAX_SAFE_INTEGER,
    });
    if (!decoded.ok) {
        return { ok: false, reasonCode: decoded.reasonCode === 'header_too_large' ? 'relay_cap_exceeded' : 'frame_invalid' };
    }
    if (decoded.payload.byteLength > input.caps.maxRawPayloadBytes) {
        return { ok: false, reasonCode: 'relay_cap_exceeded', tunnelId: decoded.header.tunnelId };
    }
    return {
        ok: true,
        header: decoded.header,
        payload: decoded.payload,
        payloadBytes: decoded.payload.byteLength,
    };
}

function validateBinaryFrameDirection(input: Readonly<{
    envelope: PeerTcpTunnelRelayBinaryEnvelopeV2;
    header: PeerTcpTunnelBinaryFrameHeaderV2;
}>): string | null {
    if (input.header.kind !== 'data') return null;
    if (input.envelope.sender.kind === 'user' && input.header.direction !== 'client_to_daemon') {
        return 'direction_not_allowed';
    }
    if (input.envelope.sender.kind === 'machine' && input.header.direction !== 'daemon_to_client') {
        return 'direction_not_allowed';
    }
    return null;
}

function clearTunnelState(tunnelKey: TunnelKey): void {
    coordinatorByTunnelKey.get(tunnelKey)?.release(tunnelKey);
    coordinatorByTunnelKey.delete(tunnelKey);
    const timers = tunnelTimersByKey.get(tunnelKey);
    if (timers?.idleTimer) clearTimeout(timers.idleTimer);
    if (timers?.durationTimer) clearTimeout(timers.durationTimer);
    tunnelTimersByKey.delete(tunnelKey);
    const socketSets = socketSetsByTunnelKey.get(tunnelKey);
    if (socketSets) {
        for (const socketTunnelKeys of socketSets) {
            socketTunnelKeys.delete(tunnelKey);
        }
        socketSetsByTunnelKey.delete(tunnelKey);
    }
    authorizedTunnelKeys.delete(tunnelKey);
    bytesByTunnelKey.delete(tunnelKey);
    tunnelStartedAtByKey.delete(tunnelKey);
    tunnelLastActivityAtByKey.delete(tunnelKey);
    encodingByTunnelKey.delete(tunnelKey);
    authorizationStateByTunnelKey.delete(tunnelKey);
    voiceApplicationProtectionByTunnelKey.delete(tunnelKey);
    observabilityIdentityByTunnelKey.delete(tunnelKey);
    userSocketIdByTunnelKey.delete(tunnelKey);
    substreamsByTunnelKey.delete(tunnelKey);
}

function applyBinarySubstreamCaps(input: Readonly<{
    tunnelKey: TunnelKey;
    header: PeerTcpTunnelBinaryFrameHeaderV2;
    payloadBytes: number;
    nowMs: number;
    caps: PeerTcpTunnelRelayCaps;
    allowDataFirst: boolean;
}>): string | null {
    const substreamId = input.header.substreamId;
    if (!substreamId) return null;
    let active = substreamsByTunnelKey.get(input.tunnelKey);
    if (!active) {
        active = new Set<string>();
        substreamsByTunnelKey.set(input.tunnelKey, active);
    }
    const admitsSubstream = input.header.kind === 'open'
        || (input.allowDataFirst && input.header.kind === 'data' && !active.has(substreamId));
    if (admitsSubstream) {
        if (active.has(substreamId)) return 'frame_invalid';
        if (active.size >= input.caps.substreams.maxConcurrentSubstreams) return 'relay_cap_exceeded';
        active.add(substreamId);
    } else if (!active.has(substreamId)) {
        return 'frame_invalid';
    }
    if (input.header.kind === 'abort' || (input.header.kind === 'close' && input.header.halfClose !== true)) {
        active.delete(substreamId);
    }
    return null;
}

function trackTunnelKeyForSocket(socketTunnelKeys: Set<TunnelKey>, tunnelKey: TunnelKey): void {
    socketTunnelKeys.add(tunnelKey);
    let socketSets = socketSetsByTunnelKey.get(tunnelKey);
    if (!socketSets) {
        socketSets = new Set();
        socketSetsByTunnelKey.set(tunnelKey, socketSets);
    }
    socketSets.add(socketTunnelKeys);
}

function socketOwnsTunnel(input: Readonly<{
    socket: TunnelRelaySocket;
    envelope: PeerTcpTunnelRelayEnvelope;
    tunnelKey: TunnelKey;
}>): boolean {
    if (input.envelope.sender.kind !== 'user') return true;
    const ownerSocketId = userSocketIdByTunnelKey.get(input.tunnelKey);
    if (!ownerSocketId) return true;
    return input.socket.id === ownerSocketId;
}

function machineRecipientMatchesTunnelOwner(input: Readonly<{
    envelope: PeerTcpTunnelRelayEnvelope;
    tunnelKey: TunnelKey;
}>): boolean {
    if (input.envelope.sender.kind !== 'machine' || input.envelope.recipient.kind !== 'user') {
        return true;
    }
    const ownerSocketId = userSocketIdByTunnelKey.get(input.tunnelKey);
    if (!ownerSocketId) return false;
    return input.envelope.recipient.socketId === undefined
        || input.envelope.recipient.socketId === ownerSocketId;
}

export function registerPeerTcpTunnelRelaySocketHandler(
    userId: string,
    socket: TunnelRelaySocket,
    ctx: Readonly<{
        io: TunnelRelayIo;
        readMachineAdmission?: (machineId: string) => ReturnType<typeof resolveMachineAdmission>;
        relayAuthorizationTrustRoots?: readonly PeerTcpTunnelRelayAuthorizationTrustRootV1[];
        nowMs?: () => number;
        observability?: PeerMediationObservabilityEmitter;
        /**
         * Cluster admission owner. Required: it is the ONE decision-maker for
         * single-use relay-grant consumption and exact-machine attachment.
         */
        coordinator: PeerTcpTunnelRelayCoordinator;
        /**
         * Production supplies one canonical feature decision for each signed
         * relay flow. The scalar is retained for direct test/embedded handler
         * callers that do not have the socket composition context.
         */
        serverRoutedEnabledByFlowKind?: Readonly<Partial<Record<
            PeerTcpTunnelRelayAuthorizationPayloadV2['flowKind'],
            boolean
        >>>;
    } & Partial<PeerTcpTunnelRelayCaps>>,
): void {
    const socketObject = socket as object;
    if (registeredSockets.has(socketObject)) {
        throw new Error('Peer mediation tunnel relay handler already registered on this socket');
    }
    registeredSockets.add(socketObject);

    const caps = resolvePeerTcpTunnelRelayCaps(ctx);
    const readMachineAdmission = ctx.readMachineAdmission ?? ((machineId: string) => resolveMachineAdmission({ actorAccountId: userId, machineId }));
    const pendingCurrentnessByTunnelKey = new Map<TunnelKey, Promise<string | null>>();
    async function readCurrentInstallation(machineId: string, expectedInstallationId?: string): Promise<string | null> {
        try {
            const admission = await readMachineAdmission(machineId);
            return admission.kind === 'admitted' && admission.actorAccountId === userId && admission.custodianAccountId === userId
                && (expectedInstallationId === undefined || admission.installationId === expectedInstallationId)
                ? admission.installationId : null;
        } catch { return null; }
    }
    async function readOrderedCurrentInstallation(tunnelKey: TunnelKey, machineId: string, expectedInstallationId?: string): Promise<string | null> {
        const previous = pendingCurrentnessByTunnelKey.get(tunnelKey);
        const current = (previous ?? Promise.resolve()).then(() => readCurrentInstallation(machineId, expectedInstallationId));
        pendingCurrentnessByTunnelKey.set(tunnelKey, current);
        try { return await current; }
        finally { if (pendingCurrentnessByTunnelKey.get(tunnelKey) === current) pendingCurrentnessByTunnelKey.delete(tunnelKey); }
    }
    const isServerRoutedFlowEnabled = (
        flowKind: PeerTcpTunnelRelayAuthorizationPayloadV2['flowKind'],
    ): boolean => {
        if (ctx.serverRoutedEnabledByFlowKind) {
            return ctx.serverRoutedEnabledByFlowKind[flowKind] === true;
        }
        return caps.serverRoutedEnabled;
    };
    function emitAbort(input: Omit<
        Parameters<typeof emitAbortToRelayParticipants>[0],
        "notifyAttachedMachine"
    > & Readonly<{ notifyAttachedMachine?: boolean }>): void {
        emitAbortToRelayParticipants({
            ...input,
            notifyAttachedMachine: input.notifyAttachedMachine === true,
        });
    }
    function emitBinarySubstreamAbort(input: Omit<
        Parameters<typeof emitBinarySubstreamAbortToRelayParticipants>[0],
        "notifyAttachedMachine"
    > & Readonly<{ notifyAttachedMachine?: boolean }>): void {
        emitBinarySubstreamAbortToRelayParticipants({
            ...input,
            notifyAttachedMachine: input.notifyAttachedMachine === true,
        });
    }
    const socketTunnelKeys = new Set<TunnelKey>();
    activeTunnelKeysBySocket.set(socketObject, socketTunnelKeys);

    function scheduleTunnelTimers(
        tunnelKey: TunnelKey,
        envelope: PeerTcpTunnelRelayEnvelope,
        meteringCaps: RelayMeteringCaps,
        tunnelId?: string,
    ): void {
        const existing = tunnelTimersByKey.get(tunnelKey);
        if (existing?.idleTimer) clearTimeout(existing.idleTimer);
        if (existing?.durationTimer) clearTimeout(existing.durationTimer);
        const now = ctx.nowMs?.() ?? Date.now();
        const startedAt = tunnelStartedAtByKey.get(tunnelKey) ?? now;
        const durationRemainingMs = meteringCaps.maxDurationMs === undefined ? undefined
            : Math.max(1, meteringCaps.maxDurationMs - Math.max(0, now - startedAt));
        const idleTimer = meteringCaps.maxIdleMs === undefined ? undefined : setTimeout(() => {
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId,
                tunnelKey,
                reasonCode: 'relay_cap_exceeded',
                notifyAttachedMachine: true,
            });
            clearTunnelWithClosedReceipt({
                tunnelKey,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
            });
        }, Math.max(1, meteringCaps.maxIdleMs));
        const durationTimer = durationRemainingMs === undefined ? undefined : setTimeout(() => {
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId,
                tunnelKey,
                reasonCode: 'relay_cap_exceeded',
                notifyAttachedMachine: true,
            });
            clearTunnelWithClosedReceipt({
                tunnelKey,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
            });
        }, durationRemainingMs);
        idleTimer?.unref?.();
        durationTimer?.unref?.();
        tunnelTimersByKey.set(tunnelKey, { idleTimer, durationTimer });
    }

    function emitObservability(input: Readonly<{
        envelope?: PeerTcpTunnelRelayEnvelope;
        machineId?: string;
        tunnelId: string;
        flowKind?: PeerTcpTunnelRelayAuthorizationPayloadV2['flowKind'];
        kind: Parameters<typeof createPeerMediationFlowEvent>[0]['kind'];
        reasonCode?: string;
        bytesIn?: number;
        bytesOut?: number;
        metadata?: Readonly<Record<string, unknown>>;
    }>): void {
        const signedFlowKind = input.flowKind
            ?? (input.envelope
                ? authorizationStateByTunnelKey.get(buildTunnelKey(input.envelope, input.tunnelId))?.flowKind
                : undefined);
        const flowKind: PeerMediationObservabilityFlowKind = signedFlowKind === 'provider_broker'
            ? 'tcp_tunnel'
            : signedFlowKind ?? 'tcp_tunnel';
        ctx.observability?.emit(createPeerMediationFlowEvent({
            accountId: userId,
            machineId: input.machineId ?? (input.envelope ? participantMachineId(input.envelope) : undefined),
            flowKind,
            flowId: input.tunnelId,
            kind: input.kind,
            nowMs: ctx.nowMs?.() ?? Date.now(),
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            ...(input.bytesIn !== undefined ? { bytesIn: input.bytesIn } : {}),
            ...(input.bytesOut !== undefined ? { bytesOut: input.bytesOut } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
        }));
    }

    function clearTunnelWithClosedReceipt(input: Readonly<{
        tunnelKey: TunnelKey;
        envelope?: PeerTcpTunnelRelayEnvelope;
        tunnelId?: string;
        reasonCode?: string;
    }>): void {
        const identity = observabilityIdentityByTunnelKey.get(input.tunnelKey);
        if (!identity) {
            clearTunnelState(input.tunnelKey);
            return;
        }
        const tunnelId = input.tunnelId ?? identity.tunnelId;
        const bytes = bytesByTunnelKey.get(input.tunnelKey);
        const carrierEncoding = encodingByTunnelKey.get(input.tunnelKey);
        const signedFlowKind = authorizationStateByTunnelKey.get(input.tunnelKey)?.flowKind;
        const voiceProtection = voiceApplicationProtectionByTunnelKey.get(input.tunnelKey);
        clearTunnelState(input.tunnelKey);
        emitObservability({
            ...(input.envelope ? { envelope: input.envelope } : {}),
            ...(identity.machineId ? { machineId: identity.machineId } : {}),
            tunnelId,
            ...(signedFlowKind ? { flowKind: signedFlowKind } : {}),
            kind: 'flow.closed',
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            ...(bytes ? { bytesIn: bytes.in, bytesOut: bytes.out } : {}),
            metadata: {
                ...(carrierEncoding ? { carrierEncoding } : {}),
                ...(signedFlowKind ? { signedFlowKind } : {}),
                ...(voiceProtection ? {
                    encryptedApplicationFrames: voiceProtection.encryptedApplicationFrames,
                    unprotectedApplicationFrames: voiceProtection.unprotectedApplicationFrames,
                    allApplicationFramesEncrypted:
                        voiceProtection.encryptedApplicationFrames > 0
                        && voiceProtection.unprotectedApplicationFrames === 0,
                } : {}),
                cleanupSettled: true,
            },
        });
    }

    function createSocketLossAbortEnvelope(tunnelKey: TunnelKey): PeerTcpTunnelRelayEnvelopeV1 | null {
        const identity = observabilityIdentityByTunnelKey.get(tunnelKey);
        if (!identity?.machineId) return null;
        const userSocketId = userSocketIdByTunnelKey.get(tunnelKey);
        const disconnectedMachine =
            socket.data?.clientType === 'machine-scoped'
            && socket.data.machineId === identity.machineId;
        const disconnectedUser =
            socket.data?.clientType === 'user-scoped'
            || socket.data?.clientType === 'session-scoped';
        if (!disconnectedMachine && !disconnectedUser) return null;

        return {
            v: 1,
            scopeUserId: userId,
            sender: disconnectedMachine
                ? { kind: 'machine', machineId: identity.machineId }
                : { kind: 'user', ...(userSocketId ? { socketId: userSocketId } : {}) },
            recipient: disconnectedMachine
                ? { kind: 'user', ...(userSocketId ? { socketId: userSocketId } : {}) }
                : { kind: 'machine', machineId: identity.machineId },
            frame: {
                v: 1,
                kind: 'abort',
                tunnelId: identity.tunnelId,
                reasonCode: 'relay_socket_disconnected',
            },
        };
    }

    type PendingOpen = {
        ready: Promise<void>;
        resolveReady(): void;
        cancelledReason: 'relay_cap_exceeded' | 'relay_socket_disconnected' | 'route_unavailable' | null;
        queuedBytes: number;
    };
    const pendingOpenByTunnelKey = new Map<TunnelKey, PendingOpen>();
    let ownerSocketDisconnected = false;

    function settleMachineDisconnect(input: Readonly<{
        tunnelKey: TunnelKey;
        tunnelId: string;
        machineId: string;
        ownerSocketId: string | undefined;
    }>): void {
        const pending = pendingOpenByTunnelKey.get(input.tunnelKey);
        if (pending && !authorizedTunnelKeys.has(input.tunnelKey)) {
            pending.cancelledReason = 'relay_socket_disconnected';
            return;
        }
        if (!authorizedTunnelKeys.has(input.tunnelKey)) return;
        const abortEnvelope: PeerTcpTunnelRelayEnvelopeV1 = {
            v: 1,
            scopeUserId: userId,
            sender: { kind: 'machine', machineId: input.machineId },
            recipient: { kind: 'user', ...(input.ownerSocketId ? { socketId: input.ownerSocketId } : {}) },
            frame: {
                v: 1,
                kind: 'abort',
                tunnelId: input.tunnelId,
                reasonCode: 'relay_socket_disconnected',
            },
        };
        clearTunnelWithClosedReceipt({
            tunnelKey: input.tunnelKey,
            envelope: abortEnvelope,
            tunnelId: input.tunnelId,
            reasonCode: 'relay_socket_disconnected',
        });
        emitEnvelopeToParticipant({
            io: ctx.io,
            userId,
            participant: abortEnvelope.recipient,
            envelope: abortEnvelope,
            tunnelKey: input.tunnelKey,
            boundUserSocketId: input.ownerSocketId,
            notifyAttachedMachine: false,
        });
    }

    async function handleRelayPayload(
        raw: unknown,
        socket: TunnelRelaySocket,
        ingress: "socket" | "coordinator_exact" = "socket",
    ): Promise<void> {
        const parsed = PeerTcpTunnelRelayEnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
            const abortEnvelope = readInvalidRelayAuthorizationOpenAbortEnvelope(raw, userId);
            if (abortEnvelope && senderMatchesSocket(socket, abortEnvelope.envelope.sender)) {
                emitAbort({
                    io: ctx.io,
                    userId,
                    envelope: abortEnvelope.envelope,
                    tunnelId: abortEnvelope.tunnelId,
                    reasonCode: abortEnvelope.reasonCode,
                    senderSocketId: socket.id,
                });
            }
            emitSocketError(socket, 'Invalid peer tunnel relay payload');
            return;
        }

        const envelope = parsed.data;
        if (envelope.scopeUserId !== userId) {
            emitSocketError(socket, 'Peer tunnel relay scope user does not match the authenticated socket user');
            return;
        }
        if (!senderMatchesSocket(socket, envelope.sender)) {
            const reasonCode = envelope.v === 1
                && envelope.frame.kind === 'open'
                && envelope.sender.kind === 'user'
                && validateRelayAuthorization({
                    envelope,
                    relaySocketId: socket.id,
                    nowMs: ctx.nowMs?.() ?? Date.now(),
                    trustRoots: ctx.relayAuthorizationTrustRoots,
                }) === null
                ? 'relay_authorization_invalid'
                : 'socket_binding_mismatch';
            emitAbort({ io: ctx.io, userId, envelope, reasonCode, senderSocketId: socket.id });
            emitSocketError(socket, 'Peer tunnel relay sender does not match the authenticated socket binding');
            return;
        }
        if (envelope.v === 1 && envelope.frame.kind !== 'open') {
            emitSocketError(socket, 'Peer tunnel relay session frames require binary_frame_v2');
            return;
        }

        const decodedBinary = envelope.v === 2 ? decodeBinaryEnvelope({ envelope, caps }) : null;
        if (decodedBinary && !decodedBinary.ok) {
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId: decodedBinary.tunnelId,
                reasonCode: decodedBinary.reasonCode,
                senderSocketId: socket.id,
            });
            emitSocketError(socket, 'Server-routed peer tunnel binary frame failed validation');
            return;
        }
        const tunnelId = envelope.v === 1 ? getFrameTunnelId(envelope.frame) : decodedBinary?.header.tunnelId ?? '';
        const tunnelKey = buildTunnelKey(envelope, tunnelId);
        let now = ctx.nowMs?.() ?? Date.now();
        const openEnvelope = envelope.v === 1 && envelope.frame.kind === 'open' ? envelope : null;
        const isV1OpenFrame = openEnvelope !== null;
        const isTerminalFrame =
            envelope.v === 1
                ? envelope.frame.kind === 'close' || envelope.frame.kind === 'abort'
                : decodedBinary?.ok === true
                    && !decodedBinary.header.substreamId
                    && (decodedBinary.header.kind === 'close' || decodedBinary.header.kind === 'abort');

        const machineId = participantMachineId(envelope);
        let currentInstallationId: string | null = null;

        if (envelope.sender.kind === 'machine' && socket.id && ingress === "socket") {
            const routeResult = ctx.coordinator.routeMachineEnvelope({
                tunnelKey,
                machineSocketId: socket.id,
                envelope,
            });
            if (routeResult === "remote_forwarded") return;
            if (routeResult === "rejected") {
                emitSocketError(socket, 'Server-routed peer tunnel sender is not the exact attached machine socket');
                return;
            }
        }

        if (!isV1OpenFrame) {
            const pending = pendingOpenByTunnelKey.get(tunnelKey);
            if (pending) {
                const queuedBytes = envelope.v === 1
                    ? 0
                    : envelope.frame.byteLength;
                // Bound the admission buffer, including empty/control-frame headers, by existing child credit capacity.
                const maxQueuedBytes = PEER_TCP_TUNNEL_MAX_WINDOW_BYTES * caps.substreams.maxConcurrentSubstreams;
                pending.queuedBytes += queuedBytes;
                if (
                    pending.queuedBytes > maxQueuedBytes
                ) {
                    pending.cancelledReason = 'relay_cap_exceeded';
                    emitAbort({
                        io: ctx.io,
                        userId,
                        envelope,
                        tunnelId,
                        reasonCode: 'relay_cap_exceeded',
                        tunnelKey,
                        senderSocketId: socket.id,
                    });
                    emitSocketError(socket, 'Server-routed peer tunnel pending attachment cap exceeded');
                    return;
                }
                await pending.ready;
                pending.queuedBytes -= queuedBytes;
                if (pending.cancelledReason || ownerSocketDisconnected) return;
            }
            currentInstallationId = machineId ? await readOrderedCurrentInstallation(tunnelKey, machineId, authorizationStateByTunnelKey.get(tunnelKey)?.installationId) : null;
            if (!currentInstallationId || (envelope.sender.kind === 'machine' && ingress === 'socket'
                && socket.data?.verifiedMachineInstallationId !== currentInstallationId)) {
                emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'route_unavailable', tunnelKey, senderSocketId: socket.id, notifyAttachedMachine: true });
                clearTunnelState(tunnelKey);
                emitSocketError(socket, 'Server-routed peer tunnel Machine admission is no longer current');
                return;
            }
            now = ctx.nowMs?.() ?? Date.now();
        }

        // Production socket composition provides a flow map and therefore waits
        // for the verified signed flow kind below. Direct embedded callers that
        // only provide the existing scalar retain its historical fail-closed
        // boundary before destination policy is evaluated.
        if (ctx.serverRoutedEnabledByFlowKind === undefined && !caps.serverRoutedEnabled) {
            emitObservability({
                envelope,
                tunnelId,
                kind: 'flow.denied',
                reasonCode: 'relay_disabled_by_server_policy',
            });
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                reasonCode: 'relay_disabled_by_server_policy',
                tunnelKey,
                senderSocketId: socket.id,
            });
            emitSocketError(socket, 'Server-routed peer tunnels are disabled on this server');
            return;
        }

        const policyDenyReason = envelope.v === 1 ? validateOpenFramePolicy({ envelope, caps }) : null;
        if (policyDenyReason) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: policyDenyReason });
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: policyDenyReason, tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel destination policy denied the tunnel');
            return;
        }

        const relayAuthorizationPayload = openEnvelope
            ? validateRelayAuthorization({
                envelope: openEnvelope,
                relaySocketId: socket.id,
                nowMs: now,
                trustRoots: ctx.relayAuthorizationTrustRoots,
            })
            : null;
        if (openEnvelope && relayAuthorizationPayload === null) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'relay_authorization_invalid' });
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'relay_authorization_invalid', tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel relay authorization is invalid');
            return;
        }
        const openingAuthorization = relayAuthorizationPayload === null
            ? null
            : {
                payload: relayAuthorizationPayload,
                state: {
                    flowKind: relayAuthorizationPayload.flowKind,
                    meteringCaps: resolveEffectiveRelayMeteringCaps(caps, relayAuthorizationPayload),
                } satisfies AuthorizedRelayState,
            };
        if (openingAuthorization && !isServerRoutedFlowEnabled(openingAuthorization.state.flowKind)) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'relay_disabled_by_server_policy' });
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                reasonCode: 'relay_disabled_by_server_policy',
                tunnelKey,
                senderSocketId: socket.id,
            });
            emitSocketError(socket, 'Server-routed peer tunnel flow is disabled on this server');
            return;
        }

        const directionDenyReason = envelope.v === 1
            ? null
            : decodedBinary && decodedBinary.ok
                ? validateBinaryFrameDirection({ envelope, header: decodedBinary.header })
                : null;
        if (directionDenyReason) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: directionDenyReason });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: directionDenyReason, tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel frame direction does not match sender binding');
            return;
        }

        const pendingOpenCount = pendingOpenByTunnelKey.size;
        if (
            !socketTunnelKeys.has(tunnelKey)
            && !pendingOpenByTunnelKey.has(tunnelKey)
            && socketTunnelKeys.size + pendingOpenCount >= caps.maxActiveTunnelsPerSocket
        ) {
            emitObservability({ envelope, tunnelId, kind: 'cap.exceeded', reasonCode: 'relay_cap_exceeded' });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_cap_exceeded', tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel active tunnel cap exceeded');
            return;
        }

        if (isV1OpenFrame && (authorizedTunnelKeys.has(tunnelKey) || pendingOpenByTunnelKey.has(tunnelKey))) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'tunnel_id_already_open' });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'tunnel_id_already_open', tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel is already open');
            return;
        }

        if (!isV1OpenFrame && !authorizedTunnelKeys.has(tunnelKey)) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'tunnel_not_open' });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'tunnel_not_open', tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel frame arrived before an authorized open');
            return;
        }

        const encodingDenyReason = envelope.v === 1
            ? validateSelectedOpenEncoding({ frame: envelope.frame, caps })
            : encodingByTunnelKey.get(tunnelKey) !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
                ? 'encoding_unsupported'
                : null;
        if (encodingDenyReason) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: encodingDenyReason });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: encodingDenyReason, tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel encoding is unsupported for this tunnel');
            return;
        }

        if (!isV1OpenFrame && !socketOwnsTunnel({ socket, envelope, tunnelKey })) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'socket_binding_mismatch' });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'socket_binding_mismatch', tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel sender does not own the active tunnel');
            return;
        }

        if (!isV1OpenFrame && !machineRecipientMatchesTunnelOwner({ envelope, tunnelKey })) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'socket_binding_mismatch' });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'socket_binding_mismatch', tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel recipient does not own the active tunnel');
            return;
        }

        const authorizationState = openingAuthorization?.state ?? authorizationStateByTunnelKey.get(tunnelKey);
        if (!authorizationState) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'tunnel_not_open' });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'tunnel_not_open', tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel has no admitted authorization state');
            return;
        }
        if (!isV1OpenFrame && !isServerRoutedFlowEnabled(authorizationState.flowKind)) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'relay_disabled_by_server_policy' });
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId,
                reasonCode: 'relay_disabled_by_server_policy',
                tunnelKey,
                senderSocketId: socket.id,
            });
            emitSocketError(socket, 'Server-routed peer tunnel flow is disabled on this server');
            return;
        }

        if (openingAuthorization) {
            const { payload } = openingAuthorization;
            let resolveReady!: () => void;
            const ready = new Promise<void>((resolve) => {
                resolveReady = resolve;
            });
            const pending: PendingOpen = {
                ready,
                resolveReady,
                cancelledReason: null,
                queuedBytes: 0,
            };
            pendingOpenByTunnelKey.set(tunnelKey, pending);
            currentInstallationId = await readCurrentInstallation(payload.targetMachineId);
            if (!currentInstallationId || ownerSocketDisconnected || pending.cancelledReason) {
                pendingOpenByTunnelKey.delete(tunnelKey);
                pending.cancelledReason ??= 'route_unavailable';
                pending.resolveReady();
                emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'route_unavailable', tunnelKey, senderSocketId: socket.id });
                return;
            }
            const admissionPromise = ctx.coordinator.admit({
                accountId: userId,
                tunnelKey,
                grantId: payload.grantId,
                grantExpiresAt: payload.exp,
                machineId: payload.targetMachineId,
                expectedInstallationId: currentInstallationId,
                nowMs: now,
                onMachineEnvelope: (machineEnvelope, machineSocketId) => handleRelayPayload(
                    machineEnvelope,
                    {
                        id: machineSocketId,
                        data: {
                            clientType: 'machine-scoped',
                            machineId: payload.targetMachineId,
                        },
                        on: () => undefined,
                        emit: (event, value) => ctx.io.to(machineSocketId).emit(event, value),
                    },
                    "coordinator_exact",
                ),
                onMachineDisconnect: () => {
                    settleMachineDisconnect({
                        tunnelKey,
                        tunnelId,
                        machineId: payload.targetMachineId,
                        ownerSocketId: socket.id,
                    });
                },
            });
            const admission = await admissionPromise;
            const installationStillCurrent = await readCurrentInstallation(payload.targetMachineId, currentInstallationId);
            now = ctx.nowMs?.() ?? Date.now();
            if (admission.status !== 'attached') {
                pendingOpenByTunnelKey.delete(tunnelKey);
                pending.resolveReady();
                const reasonCode = admission.reason === 'grant_already_consumed'
                    ? 'relay_authorization_invalid'
                    : 'route_unavailable';
                emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode });
                emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode, tunnelKey, senderSocketId: socket.id });
                emitSocketError(socket, 'Server-routed peer tunnel cluster admission failed');
                return;
            }
            if (ownerSocketDisconnected || pending.cancelledReason || !installationStillCurrent || payload.exp <= now) {
                pendingOpenByTunnelKey.delete(tunnelKey);
                pending.resolveReady();
                ctx.coordinator.release(tunnelKey);
                if (!ownerSocketDisconnected) {
                    const reasonCode = pending.cancelledReason ?? 'route_unavailable';
                    emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode, tunnelKey, senderSocketId: socket.id });
                }
                return;
            }
            coordinatorByTunnelKey.set(tunnelKey, ctx.coordinator);
            authorizationStateByTunnelKey.set(tunnelKey, { ...authorizationState, installationId: currentInstallationId });
        }

        const lastActivityAt = tunnelLastActivityAtByKey.get(tunnelKey) ?? now;
        const substreamDenyReason = envelope.v === 2 && decodedBinary?.ok === true
            ? applyBinarySubstreamCaps({
                tunnelKey,
                header: decodedBinary.header,
                payloadBytes: decodedBinary.payloadBytes,
                nowMs: now,
                caps,
                allowDataFirst: authorizationState.flowKind === 'voice_media',
            })
            : null;
        if (substreamDenyReason) {
            if (envelope.v === 2 && decodedBinary?.ok === true && decodedBinary.header.substreamId) {
                emitBinarySubstreamAbort({
                    io: ctx.io,
                    userId,
                    envelope,
                    tunnelId,
                    substreamId: decodedBinary.header.substreamId,
                    reasonCode: substreamDenyReason,
                    tunnelKey,
                    senderSocketId: socket.id,
                    notifyAttachedMachine: true,
                });
            } else {
                emitAbort({
                    io: ctx.io,
                    userId,
                    envelope,
                    tunnelId,
                    reasonCode: substreamDenyReason,
                    tunnelKey,
                    senderSocketId: socket.id,
                    notifyAttachedMachine: true,
                });
            }
            emitObservability({ envelope, tunnelId, kind: substreamDenyReason === 'relay_cap_exceeded' ? 'cap.exceeded' : 'flow.denied', reasonCode: substreamDenyReason });
            emitSocketError(socket, 'Server-routed peer tunnel substream cap or lifecycle check failed');
            return;
        }

        const decodedBytes = envelope.v === 1
            ? 0
            : decodedBinary?.payloadBytes ?? 0;
        const currentBytes = bytesByTunnelKey.get(tunnelKey) ?? { in: 0, out: 0 };
        const nextBytes = envelope.sender.kind === 'user'
            ? { in: currentBytes.in + decodedBytes, out: currentBytes.out }
            : { in: currentBytes.in, out: currentBytes.out + decodedBytes };
        if (
            decodedBytes > authorizationState.meteringCaps.maxFrameBytes
            || (authorizationState.meteringCaps.maxBytes !== undefined
                && nextBytes.in + nextBytes.out > authorizationState.meteringCaps.maxBytes)
        ) {
            emitObservability({
                envelope,
                tunnelId,
                kind: 'cap.exceeded',
                reasonCode: 'relay_cap_exceeded',
                bytesIn: currentBytes.in,
                bytesOut: currentBytes.out,
            });
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
                tunnelKey,
                senderSocketId: socket.id,
                notifyAttachedMachine: true,
            });
            clearTunnelWithClosedReceipt({
                tunnelKey,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
            });
            emitSocketError(socket, 'Server-routed peer tunnel byte cap exceeded');
            return;
        }

        const startedAt = tunnelStartedAtByKey.get(tunnelKey) ?? now;
        tunnelStartedAtByKey.set(tunnelKey, startedAt);
        if (authorizationState.meteringCaps.maxDurationMs !== undefined
            && now - startedAt > authorizationState.meteringCaps.maxDurationMs) {
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
                tunnelKey,
                senderSocketId: socket.id,
                notifyAttachedMachine: true,
            });
            emitObservability({ envelope, tunnelId, kind: 'cap.exceeded', reasonCode: 'relay_cap_exceeded' });
            clearTunnelWithClosedReceipt({
                tunnelKey,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
            });
            emitSocketError(socket, 'Server-routed peer tunnel duration cap exceeded');
            return;
        }
        if (!isV1OpenFrame && authorizationState.meteringCaps.maxIdleMs !== undefined
            && now - lastActivityAt > authorizationState.meteringCaps.maxIdleMs) {
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
                tunnelKey,
                senderSocketId: socket.id,
                notifyAttachedMachine: true,
            });
            emitObservability({ envelope, tunnelId, kind: 'cap.exceeded', reasonCode: 'relay_cap_exceeded' });
            clearTunnelWithClosedReceipt({
                tunnelKey,
                envelope,
                tunnelId,
                reasonCode: 'relay_cap_exceeded',
            });
            emitSocketError(socket, 'Server-routed peer tunnel idle cap exceeded');
            return;
        }

        trackTunnelKeyForSocket(socketTunnelKeys, tunnelKey);
        if (envelope.v === 1 && envelope.frame.kind === 'open') {
            authorizedTunnelKeys.add(tunnelKey);
            encodingByTunnelKey.set(tunnelKey, selectedOpenEncoding(envelope.frame));
            const machineId = participantMachineId(envelope);
            observabilityIdentityByTunnelKey.set(tunnelKey, {
                tunnelId,
                ...(machineId ? { machineId } : {}),
            });
            if (authorizationState.flowKind === 'voice_media') {
                voiceApplicationProtectionByTunnelKey.set(tunnelKey, {
                    encryptedApplicationFrames: 0,
                    unprotectedApplicationFrames: 0,
                });
            }
            if (envelope.sender.kind === 'user' && socket.id) {
                userSocketIdByTunnelKey.set(tunnelKey, socket.id);
            }
        }
        if (
            envelope.v === 2
            && decodedBinary?.ok === true
            && decodedBinary.header.kind === 'data'
            && decodedBinary.header.substreamId
            && decodedBinary.payloadBytes > 0
            && authorizationState.flowKind === 'voice_media'
        ) {
            const current = voiceApplicationProtectionByTunnelKey.get(tunnelKey) ?? {
                encryptedApplicationFrames: 0,
                unprotectedApplicationFrames: 0,
            };
            const encrypted = decodePeerApplicationEncryptedFrameV1(decodedBinary.payload) !== null;
            voiceApplicationProtectionByTunnelKey.set(tunnelKey, {
                encryptedApplicationFrames: current.encryptedApplicationFrames + (encrypted ? 1 : 0),
                unprotectedApplicationFrames: current.unprotectedApplicationFrames + (encrypted ? 0 : 1),
            });
        }
        bytesByTunnelKey.set(tunnelKey, nextBytes);
        tunnelLastActivityAtByKey.set(tunnelKey, now);
        scheduleTunnelTimers(tunnelKey, envelope, authorizationState.meteringCaps, tunnelId);
        if (isV1OpenFrame) {
            const carrierEncoding = encodingByTunnelKey.get(tunnelKey);
            const signedFlowKind = authorizationState.flowKind;
            emitObservability({
                envelope,
                tunnelId,
                kind: 'flow.ready',
                metadata: {
                    ...(carrierEncoding ? { carrierEncoding } : {}),
                    ...(signedFlowKind ? { signedFlowKind } : {}),
                },
            });
        }
        if (envelope.recipient.kind === 'machine') {
            ctx.coordinator.routeOwnerEnvelope({
                tunnelKey,
                envelope,
            });
        } else {
            emitEnvelopeToParticipant({
                io: ctx.io,
                userId,
                participant: envelope.recipient,
                envelope,
                tunnelKey,
                notifyAttachedMachine: false,
            });
        }
        if (isV1OpenFrame) {
            const pending = pendingOpenByTunnelKey.get(tunnelKey);
            pendingOpenByTunnelKey.delete(tunnelKey);
            pending?.resolveReady();
        }

        if (isTerminalFrame) {
            clearTunnelWithClosedReceipt({
                tunnelKey,
                envelope,
                tunnelId,
            });
        }
    }

    // Frame handling is asynchronous because cluster admission is. Socket.IO
    // ignores the returned promise, but returning it gives callers that drive
    // the handler directly a settlement to join instead of a timing guess.
    socket.on(
        PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
        (raw: unknown) => handleRelayPayload(raw, socket),
    );

    socket.on('disconnect', () => {
        ownerSocketDisconnected = true;
        for (const pending of pendingOpenByTunnelKey.values()) {
            pending.cancelledReason = 'relay_socket_disconnected';
        }
        for (const tunnelKey of [...socketTunnelKeys]) {
            const abortEnvelope = createSocketLossAbortEnvelope(tunnelKey);
            if (abortEnvelope) {
                emitEnvelopeToParticipant({
                    io: ctx.io,
                    userId,
                    participant: abortEnvelope.recipient,
                    envelope: abortEnvelope,
                    tunnelKey,
                    boundUserSocketId: abortEnvelope.recipient.kind === 'user'
                        ? abortEnvelope.recipient.socketId
                        : undefined,
                    notifyAttachedMachine: true,
                });
            }
            clearTunnelWithClosedReceipt({
                tunnelKey,
                reasonCode: 'relay_socket_disconnected',
            });
        }
        socketTunnelKeys.clear();
    });
}
