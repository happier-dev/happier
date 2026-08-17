import {
    decodePeerApplicationEncryptedFrameV1,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PeerTcpTunnelRelayEnvelopeSchema,
    PeerTcpTunnelRelayEnvelopeV1Schema,
    validatePeerTcpTunnelDataFrameCaps,
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
import { resolvePeerTcpTunnelRelayCaps, type PeerTcpTunnelRelayCaps } from './relayCaps';
import {
    createPeerMediationFlowEvent,
    type PeerMediationObservabilityEmitter,
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

const registeredSockets = new WeakSet<object>();
const activeTunnelKeysBySocket = new WeakMap<object, Set<TunnelKey>>();
const socketSetsByTunnelKey = new Map<TunnelKey, Set<Set<TunnelKey>>>();
const authorizedTunnelKeys = new Set<TunnelKey>();
const consumedRelayAuthorizationExpByGrantId = new Map<string, number>();
const bytesByTunnelKey = new Map<TunnelKey, Readonly<{ in: number; out: number }>>();
const encodingByTunnelKey = new Map<TunnelKey, PeerTcpTunnelEncoding>();
const flowKindByTunnelKey = new Map<TunnelKey, PeerTcpTunnelRelayAuthorizationPayloadV2['flowKind']>();
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
const substreamsByTunnelKey = new Map<TunnelKey, {
    activeSubstreamIds: Set<string>;
    terminalSubstreamIds: Set<string>;
    totalOpened: number;
    aggregateBytes: number;
    bytesBySubstreamId: Map<string, number>;
    lastActivityBySubstreamId: Map<string, number>;
}>();
const tunnelTimersByKey = new Map<TunnelKey, Readonly<{
    idleTimer?: ReturnType<typeof setTimeout>;
    durationTimer?: ReturnType<typeof setTimeout>;
}>>();
const coordinatorByTunnelKey = new Map<TunnelKey, PeerTcpTunnelRelayCoordinator>();
const localMachineSocketByAccountAndMachine = new Map<string, Readonly<{
    socket: TunnelRelaySocket;
    tunnelKeys: Set<TunnelKey>;
}>>();

function localMachineSocketKey(accountId: string, machineId: string): string {
    return `${accountId}\u0000${machineId}`;
}

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

function normalizeHost(host: string): string {
    const trimmed = host.trim().toLowerCase();
    return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function isIpv4LoopbackHost(host: string): boolean {
    const parts = host.split('.');
    if (parts.length !== 4 || parts[0] !== '127') return false;
    return parts.slice(1).every((part) => {
        if (!/^\d+$/.test(part)) return false;
        const value = Number(part);
        return Number.isInteger(value) && value >= 0 && value <= 255;
    });
}

function isLoopbackHost(host: string): boolean {
    const normalized = normalizeHost(host);
    return normalized === 'localhost' || normalized === '::1' || isIpv4LoopbackHost(normalized);
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
    if (!isLoopbackHost(frame.open.destination.host)) return 'destination_host_not_allowed';
    if (!input.caps.allowedPorts.includes(frame.open.destination.port)) return 'destination_port_not_allowed';
    return null;
}

function validateRelayAuthorizationBinding(input: Readonly<{
    open: PeerTcpTunnelOpenV1;
    payload: PeerTcpTunnelRelayAuthorizationPayloadV2;
}>): string | null {
    if (input.payload.routeKind !== input.open.routeKind) return 'relay_authorization_invalid';
    if (input.payload.tunnelId !== input.open.tunnelId) return 'relay_authorization_invalid';
    if (input.payload.targetMachineId !== input.open.targetMachineId) return 'relay_authorization_invalid';
    if (normalizeHost(input.payload.destination.host) !== normalizeHost(input.open.destination.host)) {
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
}>): string | null {
    const frame = input.envelope.frame;
    if (frame.kind !== 'open') return null;

    const authorization = frame.open.relayAuthorization;
    if (authorization === undefined) return 'relay_authorization_invalid';
    if (input.trustRoots === undefined || input.trustRoots.length === 0) {
        return 'relay_authorization_invalid';
    }

    const payload = authorization.payload;
    if (payload.accountId !== input.envelope.scopeUserId) return 'relay_authorization_invalid';
    const verification = verifyPeerTcpTunnelRelayAuthorizationV2({
        authorization,
        nowMs: input.nowMs,
        trustRoots: input.trustRoots,
    });
    if (!verification.valid) return 'relay_authorization_invalid';
    if (
        input.relaySocketId !== verification.payload.relaySocketId
        || input.envelope.sender.kind !== 'user'
        || input.envelope.sender.socketId !== verification.payload.relaySocketId
    ) {
        return 'relay_authorization_invalid';
    }
    return validateRelayAuthorizationBinding({ open: frame.open, payload: verification.payload });
}

function validateRelayFrameDirection(envelope: PeerTcpTunnelRelayEnvelopeV1): string | null {
    if (envelope.frame.kind !== 'data') return null;
    if (envelope.sender.kind === 'user' && envelope.frame.direction !== 'client_to_daemon') {
        return 'direction_not_allowed';
    }
    if (envelope.sender.kind === 'machine' && envelope.frame.direction !== 'daemon_to_client') {
        return 'direction_not_allowed';
    }
    return null;
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

function emitEnvelopeToParticipant(input: Readonly<{
    io: TunnelRelayIo;
    userId: string;
    participant: PeerTcpTunnelRelayParticipantV1;
    envelope: PeerTcpTunnelRelayEnvelope;
    tunnelKey?: TunnelKey;
    boundUserSocketId?: string;
    coordinatorBacked: boolean;
    notifyAttachedMachine: boolean;
}>): void {
    if (input.participant.kind === 'machine' && input.coordinatorBacked) {
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
    const target = input.participant.kind === 'user' && input.coordinatorBacked
        ? input.io.local.to(room)
        : input.io.to(room);
    target.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, input.envelope);
}

function emitAbortToRelayParticipants(input: Readonly<{
    io: TunnelRelayIo;
    userId: string;
    envelope: PeerTcpTunnelRelayEnvelope;
    tunnelId?: string;
    reasonCode: string;
    tunnelKey?: TunnelKey;
    senderSocketId?: string;
    coordinatorBacked: boolean;
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
        coordinatorBacked: input.coordinatorBacked,
        notifyAttachedMachine: input.notifyAttachedMachine,
    });
    emitEnvelopeToParticipant({
        io: input.io,
        userId: input.userId,
        participant: input.envelope.sender,
        tunnelKey: input.tunnelKey,
        boundUserSocketId: input.envelope.sender.kind === 'user' ? input.senderSocketId : undefined,
        envelope: payload,
        coordinatorBacked: input.coordinatorBacked,
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
    coordinatorBacked: boolean;
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
        coordinatorBacked: input.coordinatorBacked,
        notifyAttachedMachine: input.notifyAttachedMachine,
    });
    emitEnvelopeToParticipant({
        io: input.io,
        userId: input.userId,
        participant: input.envelope.sender,
        tunnelKey: input.tunnelKey,
        boundUserSocketId: input.envelope.sender.kind === 'user' ? input.senderSocketId : undefined,
        envelope: payload,
        coordinatorBacked: input.coordinatorBacked,
        notifyAttachedMachine: input.notifyAttachedMachine,
    });
}

function frameDecodedBytes(frame: PeerTcpTunnelFrameV1, maxFrameBytes: number): number {
    if (frame.kind !== 'data') return 0;
    const capped = validatePeerTcpTunnelDataFrameCaps({
        frame,
        maxEncodedFrameBytes: maxFrameBytes,
        maxDecodedPayloadBytes: maxFrameBytes,
    });
    return capped.ok ? capped.decodedBytes : maxFrameBytes + 1;
}

function selectedOpenEncoding(frame: PeerTcpTunnelFrameV1): PeerTcpTunnelEncoding {
    return frame.kind === 'open'
        ? frame.open.selectedEncoding ?? PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1
        : PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1;
}

function validateSelectedOpenEncoding(input: Readonly<{
    frame: PeerTcpTunnelFrameV1;
    caps: PeerTcpTunnelRelayCaps;
}>): string | null {
    if (input.frame.kind !== 'open') return null;
    const selectedEncoding = selectedOpenEncoding(input.frame);
    if (!input.caps.supportedEncodings.includes(selectedEncoding)) return 'encoding_unsupported';
    if (selectedEncoding === PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1 && !input.caps.allowV1Fallback) {
        return 'encoding_unsupported';
    }
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
    flowKindByTunnelKey.delete(tunnelKey);
    voiceApplicationProtectionByTunnelKey.delete(tunnelKey);
    observabilityIdentityByTunnelKey.delete(tunnelKey);
    userSocketIdByTunnelKey.delete(tunnelKey);
    substreamsByTunnelKey.delete(tunnelKey);
}

function cleanupConsumedRelayAuthorizations(nowMs: number): void {
    for (const [grantId, expiresAt] of consumedRelayAuthorizationExpByGrantId) {
        if (expiresAt <= nowMs) consumedRelayAuthorizationExpByGrantId.delete(grantId);
    }
}

function consumeRelayAuthorizationGrant(input: Readonly<{ grantId: string; expiresAt: number; nowMs: number }>): boolean {
    cleanupConsumedRelayAuthorizations(input.nowMs);
    if (consumedRelayAuthorizationExpByGrantId.has(input.grantId)) {
        return false;
    }
    consumedRelayAuthorizationExpByGrantId.set(input.grantId, input.expiresAt);
    return true;
}

function substreamStateForTunnel(tunnelKey: TunnelKey): {
    activeSubstreamIds: Set<string>;
    terminalSubstreamIds: Set<string>;
    totalOpened: number;
    aggregateBytes: number;
    bytesBySubstreamId: Map<string, number>;
    lastActivityBySubstreamId: Map<string, number>;
} {
    const existing = substreamsByTunnelKey.get(tunnelKey);
    if (existing) return existing;
    const created = {
        activeSubstreamIds: new Set<string>(),
        terminalSubstreamIds: new Set<string>(),
        totalOpened: 0,
        aggregateBytes: 0,
        bytesBySubstreamId: new Map<string, number>(),
        lastActivityBySubstreamId: new Map<string, number>(),
    };
    substreamsByTunnelKey.set(tunnelKey, created);
    return created;
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

    const state = substreamStateForTunnel(input.tunnelKey);
    const lastActivity = state.lastActivityBySubstreamId.get(substreamId);
    if (state.terminalSubstreamIds.has(substreamId)) return 'frame_invalid';
    if (input.header.kind !== 'open' && (lastActivity === undefined || !state.activeSubstreamIds.has(substreamId))) {
        if (!input.allowDataFirst || input.header.kind !== 'data') return 'frame_invalid';
        if (
            state.activeSubstreamIds.size >= input.caps.substreams.maxConcurrentSubstreams
            || state.totalOpened >= input.caps.substreams.maxTotalSubstreams
        ) {
            return 'relay_cap_exceeded';
        }
        state.activeSubstreamIds.add(substreamId);
        state.totalOpened += 1;
        state.bytesBySubstreamId.set(substreamId, 0);
    }
    if (
        lastActivity !== undefined
        && input.nowMs - lastActivity > input.caps.substreams.maxSubstreamIdleMs
    ) {
        state.activeSubstreamIds.delete(substreamId);
        state.bytesBySubstreamId.delete(substreamId);
        state.lastActivityBySubstreamId.delete(substreamId);
        state.terminalSubstreamIds.add(substreamId);
        return 'relay_cap_exceeded';
    }

    if (input.header.kind === 'open') {
        if (state.activeSubstreamIds.has(substreamId)) return 'frame_invalid';
        if (
            state.activeSubstreamIds.size >= input.caps.substreams.maxConcurrentSubstreams
            || state.totalOpened >= input.caps.substreams.maxTotalSubstreams
        ) {
            return 'relay_cap_exceeded';
        }
        state.activeSubstreamIds.add(substreamId);
        state.totalOpened += 1;
        state.bytesBySubstreamId.set(substreamId, 0);
        state.lastActivityBySubstreamId.set(substreamId, input.nowMs);
        return null;
    }

    if (input.header.kind === 'data') {
        const nextSubstreamBytes = (state.bytesBySubstreamId.get(substreamId) ?? 0) + input.payloadBytes;
        const nextAggregateBytes = state.aggregateBytes + input.payloadBytes;
        if (
            nextSubstreamBytes > input.caps.substreams.maxBytesPerSubstream
            || nextAggregateBytes > input.caps.substreams.maxAggregateBytes
        ) {
            state.activeSubstreamIds.delete(substreamId);
            state.bytesBySubstreamId.delete(substreamId);
            state.lastActivityBySubstreamId.delete(substreamId);
            state.terminalSubstreamIds.add(substreamId);
            return 'relay_cap_exceeded';
        }
        state.bytesBySubstreamId.set(substreamId, nextSubstreamBytes);
        state.aggregateBytes = nextAggregateBytes;
    }

    state.lastActivityBySubstreamId.set(substreamId, input.nowMs);
    const closesSubstream =
        input.header.kind === 'abort'
        || (input.header.kind === 'close' && input.header.halfClose !== true);
    if (closesSubstream) {
        state.activeSubstreamIds.delete(substreamId);
        state.bytesBySubstreamId.delete(substreamId);
        state.lastActivityBySubstreamId.delete(substreamId);
        state.terminalSubstreamIds.add(substreamId);
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
        relayAuthorizationTrustRoots?: readonly PeerTcpTunnelRelayAuthorizationTrustRootV1[];
        nowMs?: () => number;
        observability?: PeerMediationObservabilityEmitter;
        coordinator?: PeerTcpTunnelRelayCoordinator;
    } & Partial<PeerTcpTunnelRelayCaps>>,
): void {
    const socketObject = socket as object;
    if (registeredSockets.has(socketObject)) {
        throw new Error('Peer mediation tunnel relay handler already registered on this socket');
    }
    registeredSockets.add(socketObject);

    const caps = resolvePeerTcpTunnelRelayCaps(ctx);
    function emitAbort(input: Omit<
        Parameters<typeof emitAbortToRelayParticipants>[0],
        "coordinatorBacked" | "notifyAttachedMachine"
    > & Readonly<{ notifyAttachedMachine?: boolean }>): void {
        emitAbortToRelayParticipants({
            ...input,
            coordinatorBacked: ctx.coordinator !== undefined,
            notifyAttachedMachine: input.notifyAttachedMachine === true,
        });
    }
    function emitBinarySubstreamAbort(input: Omit<
        Parameters<typeof emitBinarySubstreamAbortToRelayParticipants>[0],
        "coordinatorBacked" | "notifyAttachedMachine"
    > & Readonly<{ notifyAttachedMachine?: boolean }>): void {
        emitBinarySubstreamAbortToRelayParticipants({
            ...input,
            coordinatorBacked: ctx.coordinator !== undefined,
            notifyAttachedMachine: input.notifyAttachedMachine === true,
        });
    }
    const socketTunnelKeys = new Set<TunnelKey>();
    activeTunnelKeysBySocket.set(socketObject, socketTunnelKeys);
    const localMachineKey =
        socket.data?.clientType === 'machine-scoped' && typeof socket.data.machineId === 'string'
            ? localMachineSocketKey(userId, socket.data.machineId)
            : null;
    if (localMachineKey) {
        localMachineSocketByAccountAndMachine.set(localMachineKey, {
            socket,
            tunnelKeys: socketTunnelKeys,
        });
    }

    function scheduleTunnelTimers(
        tunnelKey: TunnelKey,
        envelope: PeerTcpTunnelRelayEnvelope,
        tunnelId?: string,
    ): void {
        const existing = tunnelTimersByKey.get(tunnelKey);
        if (existing?.idleTimer) clearTimeout(existing.idleTimer);
        if (existing?.durationTimer) clearTimeout(existing.durationTimer);
        const now = ctx.nowMs?.() ?? Date.now();
        const startedAt = tunnelStartedAtByKey.get(tunnelKey) ?? now;
        const durationRemainingMs = Math.max(1, caps.maxDurationMs - Math.max(0, now - startedAt));
        const idleTimer = setTimeout(() => {
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
        }, Math.max(1, caps.maxIdleMs));
        const durationTimer = setTimeout(() => {
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
        idleTimer.unref?.();
        durationTimer.unref?.();
        tunnelTimersByKey.set(tunnelKey, { idleTimer, durationTimer });
    }

    function emitObservability(input: Readonly<{
        envelope?: PeerTcpTunnelRelayEnvelope;
        machineId?: string;
        tunnelId: string;
        flowKind?: Parameters<typeof createPeerMediationFlowEvent>[0]['flowKind'];
        kind: Parameters<typeof createPeerMediationFlowEvent>[0]['kind'];
        reasonCode?: string;
        bytesIn?: number;
        bytesOut?: number;
        metadata?: Readonly<Record<string, unknown>>;
    }>): void {
        ctx.observability?.emit(createPeerMediationFlowEvent({
            accountId: userId,
            machineId: input.machineId ?? (input.envelope ? participantMachineId(input.envelope) : undefined),
            flowKind: input.flowKind
                ?? (input.envelope
                    ? flowKindByTunnelKey.get(buildTunnelKey(input.envelope, input.tunnelId))
                    : undefined)
                ?? 'tcp_tunnel',
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
        const signedFlowKind = flowKindByTunnelKey.get(input.tunnelKey);
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
        cancelledReason: 'relay_cap_exceeded' | 'relay_socket_disconnected' | null;
        queuedFrames: number;
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
            coordinatorBacked: ctx.coordinator !== undefined,
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
                }) === 'relay_authorization_invalid'
                ? 'relay_authorization_invalid'
                : 'socket_binding_mismatch';
            emitAbort({ io: ctx.io, userId, envelope, reasonCode, senderSocketId: socket.id });
            emitSocketError(socket, 'Peer tunnel relay sender does not match the authenticated socket binding');
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
        const now = ctx.nowMs?.() ?? Date.now();
        const isV1OpenFrame = envelope.v === 1 && envelope.frame.kind === 'open';
        const isTerminalFrame =
            envelope.v === 1
                ? envelope.frame.kind === 'close' || envelope.frame.kind === 'abort'
                : decodedBinary?.ok === true
                    && !decodedBinary.header.substreamId
                    && (decodedBinary.header.kind === 'close' || decodedBinary.header.kind === 'abort');

        if (envelope.sender.kind === 'machine' && socket.id && ctx.coordinator && ingress === "socket") {
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
                    ? frameDecodedBytes(envelope.frame, caps.maxFrameBytes)
                    : decodedBinary?.payloadBytes ?? 0;
                const maxQueuedFrames = Math.max(1, Math.ceil(caps.maxBytes / Math.max(1, caps.maxFrameBytes)));
                pending.queuedFrames += 1;
                pending.queuedBytes += queuedBytes;
                if (
                    pending.queuedFrames > maxQueuedFrames
                    || pending.queuedBytes > caps.maxBytes
                    || queuedBytes > caps.maxFrameBytes
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
                pending.queuedFrames -= 1;
                pending.queuedBytes -= queuedBytes;
                if (pending.cancelledReason || ownerSocketDisconnected) return;
            }
        }

        if (!caps.serverRoutedEnabled) {
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

        const authorizationDenyReason = envelope.v === 1 ? validateRelayAuthorization({
            envelope,
            relaySocketId: socket.id,
            nowMs: now,
            trustRoots: ctx.relayAuthorizationTrustRoots,
        }) : null;
        if (authorizationDenyReason) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: authorizationDenyReason });
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: authorizationDenyReason, tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel relay authorization is invalid');
            return;
        }

        const directionDenyReason = envelope.v === 1
            ? validateRelayFrameDirection(envelope)
            : decodedBinary && decodedBinary.ok
                ? validateBinaryFrameDirection({ envelope, header: decodedBinary.header })
                : null;
        if (directionDenyReason) {
            emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: directionDenyReason });
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: directionDenyReason, tunnelKey, senderSocketId: socket.id });
            emitSocketError(socket, 'Server-routed peer tunnel frame direction does not match sender binding');
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

        if (envelope.v === 1 && envelope.frame.kind === 'open') {
            const payload = envelope.frame.open.relayAuthorization?.payload;
            if (!payload) {
                emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'relay_authorization_invalid' });
                emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_authorization_invalid', tunnelKey, senderSocketId: socket.id });
                emitSocketError(socket, 'Server-routed peer tunnel relay authorization is missing');
                return;
            }
            if (ctx.coordinator) {
                let resolveReady!: () => void;
                const ready = new Promise<void>((resolve) => {
                    resolveReady = resolve;
                });
                const pending: PendingOpen = {
                    ready,
                    resolveReady,
                    cancelledReason: null,
                    queuedFrames: 0,
                    queuedBytes: 0,
                };
                pendingOpenByTunnelKey.set(tunnelKey, pending);
                const admissionPromise = ctx.coordinator.admit({
                    accountId: userId,
                    tunnelKey,
                    grantId: payload.grantId,
                    grantExpiresAt: payload.exp,
                    machineId: payload.targetMachineId,
                    maxDurationMs: Math.min(caps.maxDurationMs, payload.maxDurationMs),
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
                if (ownerSocketDisconnected || pending.cancelledReason) {
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
            } else if (!consumeRelayAuthorizationGrant({
                grantId: payload.grantId,
                expiresAt: payload.exp,
                nowMs: now,
            })) {
                emitObservability({ envelope, tunnelId, kind: 'flow.denied', reasonCode: 'relay_authorization_invalid' });
                emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_authorization_invalid', tunnelKey, senderSocketId: socket.id });
                emitSocketError(socket, 'Server-routed peer tunnel relay authorization has already been consumed');
                return;
            } else {
                const localMachine = localMachineSocketByAccountAndMachine.get(localMachineSocketKey(
                    userId,
                    payload.targetMachineId,
                ));
                if (localMachine) {
                    trackTunnelKeyForSocket(localMachine.tunnelKeys, tunnelKey);
                }
            }
        }

        const lastActivityAt = tunnelLastActivityAtByKey.get(tunnelKey) ?? now;
        if (
            envelope.v === 2
            && decodedBinary?.ok === true
            && decodedBinary.header.substreamId
            && now - lastActivityAt > caps.substreams.maxSessionIdleMs
        ) {
            emitBinarySubstreamAbort({
                io: ctx.io,
                userId,
                envelope,
                tunnelId,
                substreamId: decodedBinary.header.substreamId,
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
            emitObservability({ envelope, tunnelId, kind: 'cap.exceeded', reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel substream session idle cap exceeded');
            return;
        }

        const substreamDenyReason = envelope.v === 2 && decodedBinary?.ok === true
            ? applyBinarySubstreamCaps({
                tunnelKey,
                header: decodedBinary.header,
                payloadBytes: decodedBinary.payloadBytes,
                nowMs: now,
                caps,
                allowDataFirst: flowKindByTunnelKey.get(tunnelKey) === 'voice_media',
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

        const decodedBytes = envelope.v === 1 ? frameDecodedBytes(envelope.frame, caps.maxFrameBytes) : decodedBinary?.payloadBytes ?? 0;
        const currentBytes = bytesByTunnelKey.get(tunnelKey) ?? { in: 0, out: 0 };
        const nextBytes = envelope.sender.kind === 'user'
            ? { in: currentBytes.in + decodedBytes, out: currentBytes.out }
            : { in: currentBytes.in, out: currentBytes.out + decodedBytes };
        if (decodedBytes > caps.maxFrameBytes || nextBytes.in + nextBytes.out > caps.maxBytes) {
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
        if (now - startedAt > caps.maxDurationMs) {
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
        if (!isV1OpenFrame && now - lastActivityAt > caps.maxIdleMs) {
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
            const flowKind = envelope.frame.open.relayAuthorization?.payload.flowKind;
            if (flowKind) {
                flowKindByTunnelKey.set(tunnelKey, flowKind);
                if (flowKind === 'voice_media') {
                    voiceApplicationProtectionByTunnelKey.set(tunnelKey, {
                        encryptedApplicationFrames: 0,
                        unprotectedApplicationFrames: 0,
                    });
                }
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
            && flowKindByTunnelKey.get(tunnelKey) === 'voice_media'
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
        scheduleTunnelTimers(tunnelKey, envelope, tunnelId);
        if (isV1OpenFrame) {
            const carrierEncoding = encodingByTunnelKey.get(tunnelKey);
            const signedFlowKind = flowKindByTunnelKey.get(tunnelKey);
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
        if (envelope.recipient.kind === 'machine' && ctx.coordinator) {
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
                coordinatorBacked: ctx.coordinator !== undefined,
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

    socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (raw: unknown) => {
        void handleRelayPayload(raw, socket);
    });

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
                    coordinatorBacked: ctx.coordinator !== undefined,
                    notifyAttachedMachine: true,
                });
            }
            clearTunnelWithClosedReceipt({
                tunnelKey,
                reasonCode: 'relay_socket_disconnected',
            });
        }
        socketTunnelKeys.clear();
        if (localMachineKey) {
            const registered = localMachineSocketByAccountAndMachine.get(localMachineKey);
            if (registered?.socket === socket) {
                localMachineSocketByAccountAndMachine.delete(localMachineKey);
            }
        }
    });
}
