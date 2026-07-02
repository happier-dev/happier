import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PeerTcpTunnelRelayEnvelopeSchema,
    PeerTcpTunnelRelayEnvelopeV1Schema,
    validatePeerTcpTunnelDataFrameCaps,
    verifyPeerTcpTunnelRelayAuthorizationV1,
    type PeerTcpTunnelBinaryFrameHeaderV2,
    type PeerTcpTunnelEncoding,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelRelayBinaryEnvelopeV2,
    type PeerTcpTunnelRelayEnvelope,
    type PeerTcpTunnelRelayEnvelopeV1,
    type PeerTcpTunnelRelayAuthorizationTrustRootV1,
    type PeerTcpTunnelRelayParticipantV1,
} from '@happier-dev/protocol';

import { getSocketRooms } from '../../../../socketRooms';
import { resolvePeerTcpTunnelRelayCaps, type PeerTcpTunnelRelayCaps } from './relayCaps';

type TunnelRelaySocket = Readonly<{
    id?: string;
    data?: Record<string, unknown>;
    on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => unknown;
    emit: (event: string, payload: unknown) => unknown;
}>;

type TunnelRelayIo = Readonly<{
    to: (room: string) => Readonly<{ emit: (event: string, payload: unknown) => unknown }>;
}>;

type TunnelKey = string;

const registeredSockets = new WeakSet<object>();
const activeTunnelKeysBySocket = new WeakMap<object, Set<TunnelKey>>();
const socketSetsByTunnelKey = new Map<TunnelKey, Set<Set<TunnelKey>>>();
const authorizedTunnelKeys = new Set<TunnelKey>();
const consumedRelayAuthorizationExpByGrantId = new Map<string, number>();
const bytesByTunnelKey = new Map<TunnelKey, number>();
const encodingByTunnelKey = new Map<TunnelKey, PeerTcpTunnelEncoding>();
const tunnelStartedAtByKey = new Map<TunnelKey, number>();
const tunnelLastActivityAtByKey = new Map<TunnelKey, number>();
const substreamsByTunnelKey = new Map<TunnelKey, {
    activeSubstreamIds: Set<string>;
    totalOpened: number;
    aggregateBytes: number;
    bytesBySubstreamId: Map<string, number>;
    lastActivityBySubstreamId: Map<string, number>;
}>();
const tunnelTimersByKey = new Map<TunnelKey, Readonly<{
    idleTimer?: ReturnType<typeof setTimeout>;
    durationTimer?: ReturnType<typeof setTimeout>;
}>>();

function getFrameTunnelId(frame: PeerTcpTunnelFrameV1): string {
    return frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
}

function getEnvelopeTunnelId(envelope: PeerTcpTunnelRelayEnvelope, header?: PeerTcpTunnelBinaryFrameHeaderV2): string {
    return envelope.v === 1 ? getFrameTunnelId(envelope.frame) : header?.tunnelId ?? '';
}

function participantRoom(userId: string, participant: PeerTcpTunnelRelayParticipantV1): string {
    if (participant.kind === 'machine') {
        return getSocketRooms({
            userId,
            clientType: 'machine-scoped',
            machineId: participant.machineId,
        })[0] ?? `machine:${participant.machineId}:${userId}`;
    }
    return getSocketRooms({
        userId,
        clientType: 'user-scoped',
    })[0] ?? `user:${userId}`;
}

function participantKey(participant: PeerTcpTunnelRelayParticipantV1): string {
    return participant.kind === 'machine' ? `machine:${participant.machineId}` : 'user';
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

function validateRelayAuthorization(input: Readonly<{
    envelope: PeerTcpTunnelRelayEnvelopeV1;
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
    const verification = verifyPeerTcpTunnelRelayAuthorizationV1({
        authorization,
        nowMs: input.nowMs,
        trustRoots: input.trustRoots,
    });
    return verification.valid ? null : 'relay_authorization_invalid';
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
    return clientType === 'user-scoped' || clientType === 'session-scoped';
}

function emitAbort(input: Readonly<{
    io: TunnelRelayIo;
    userId: string;
    envelope: PeerTcpTunnelRelayEnvelope;
    tunnelId?: string;
    reasonCode: string;
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
    input.io.to(participantRoom(input.userId, input.envelope.recipient)).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
    input.io.to(participantRoom(input.userId, input.envelope.sender)).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
}

function emitBinarySubstreamAbort(input: Readonly<{
    io: TunnelRelayIo;
    userId: string;
    envelope: PeerTcpTunnelRelayBinaryEnvelopeV2;
    tunnelId: string;
    substreamId: string;
    reasonCode: string;
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
    input.io.to(participantRoom(input.userId, input.envelope.recipient)).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
    input.io.to(participantRoom(input.userId, input.envelope.sender)).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
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
}>): Readonly<{ ok: true; header: PeerTcpTunnelBinaryFrameHeaderV2; payloadBytes: number }> | Readonly<{
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
    return { ok: true, header: decoded.header, payloadBytes: decoded.payload.byteLength };
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
    totalOpened: number;
    aggregateBytes: number;
    bytesBySubstreamId: Map<string, number>;
    lastActivityBySubstreamId: Map<string, number>;
} {
    const existing = substreamsByTunnelKey.get(tunnelKey);
    if (existing) return existing;
    const created = {
        activeSubstreamIds: new Set<string>(),
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
}>): string | null {
    const substreamId = input.header.substreamId;
    if (!substreamId) return null;

    const state = substreamStateForTunnel(input.tunnelKey);
    const lastActivity = state.lastActivityBySubstreamId.get(substreamId);
    if (
        input.header.kind !== 'open'
        && (lastActivity === undefined || !state.activeSubstreamIds.has(substreamId))
    ) {
        return 'frame_invalid';
    }
    if (
        lastActivity !== undefined
        && input.nowMs - lastActivity > input.caps.substreams.maxSubstreamIdleMs
    ) {
        state.activeSubstreamIds.delete(substreamId);
        state.bytesBySubstreamId.delete(substreamId);
        state.lastActivityBySubstreamId.delete(substreamId);
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

export function registerPeerTcpTunnelRelaySocketHandler(
    userId: string,
    socket: TunnelRelaySocket,
    ctx: Readonly<{
        io: TunnelRelayIo;
        relayAuthorizationTrustRoots?: readonly PeerTcpTunnelRelayAuthorizationTrustRootV1[];
        nowMs?: () => number;
    } & Partial<PeerTcpTunnelRelayCaps>>,
): void {
    const socketObject = socket as object;
    if (registeredSockets.has(socketObject)) {
        throw new Error('Peer mediation tunnel relay handler already registered on this socket');
    }
    registeredSockets.add(socketObject);

    const caps = resolvePeerTcpTunnelRelayCaps(ctx);
    const socketTunnelKeys = new Set<TunnelKey>();
    activeTunnelKeysBySocket.set(socketObject, socketTunnelKeys);

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
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_cap_exceeded' });
            clearTunnelState(tunnelKey);
        }, Math.max(1, caps.maxIdleMs));
        const durationTimer = setTimeout(() => {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_cap_exceeded' });
            clearTunnelState(tunnelKey);
        }, durationRemainingMs);
        idleTimer.unref?.();
        durationTimer.unref?.();
        tunnelTimersByKey.set(tunnelKey, { idleTimer, durationTimer });
    }

    socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (raw: unknown) => {
        const parsed = PeerTcpTunnelRelayEnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
            emitSocketError(socket, 'Invalid peer tunnel relay payload');
            return;
        }

        const envelope = parsed.data;
        if (envelope.scopeUserId !== userId) {
            emitSocketError(socket, 'Peer tunnel relay scope user does not match the authenticated socket user');
            return;
        }
        if (!senderMatchesSocket(socket, envelope.sender)) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'socket_binding_mismatch' });
            emitSocketError(socket, 'Peer tunnel relay sender does not match the authenticated socket binding');
            return;
        }

        const decodedBinary = envelope.v === 2 ? decodeBinaryEnvelope({ envelope, caps }) : null;
        if (decodedBinary && !decodedBinary.ok) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId: decodedBinary.tunnelId, reasonCode: decodedBinary.reasonCode });
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

        if (!caps.serverRoutedEnabled) {
            emitAbort({
                io: ctx.io,
                userId,
                envelope,
                reasonCode: 'relay_disabled_by_server_policy',
            });
            emitSocketError(socket, 'Server-routed peer tunnels are disabled on this server');
            return;
        }

        const policyDenyReason = envelope.v === 1 ? validateOpenFramePolicy({ envelope, caps }) : null;
        if (policyDenyReason) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: policyDenyReason });
            emitSocketError(socket, 'Server-routed peer tunnel destination policy denied the tunnel');
            return;
        }

        const authorizationDenyReason = envelope.v === 1 ? validateRelayAuthorization({
            envelope,
            nowMs: now,
            trustRoots: ctx.relayAuthorizationTrustRoots,
        }) : null;
        if (authorizationDenyReason) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: authorizationDenyReason });
            emitSocketError(socket, 'Server-routed peer tunnel relay authorization is invalid');
            return;
        }

        const directionDenyReason = envelope.v === 1
            ? validateRelayFrameDirection(envelope)
            : decodedBinary && decodedBinary.ok
                ? validateBinaryFrameDirection({ envelope, header: decodedBinary.header })
                : null;
        if (directionDenyReason) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: directionDenyReason });
            emitSocketError(socket, 'Server-routed peer tunnel frame direction does not match sender binding');
            return;
        }

        const encodingDenyReason = envelope.v === 1
            ? validateSelectedOpenEncoding({ frame: envelope.frame, caps })
            : encodingByTunnelKey.get(tunnelKey) !== PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
                ? 'encoding_unsupported'
                : null;
        if (encodingDenyReason) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: encodingDenyReason });
            emitSocketError(socket, 'Server-routed peer tunnel encoding is unsupported for this tunnel');
            return;
        }

        if (!socketTunnelKeys.has(tunnelKey) && socketTunnelKeys.size >= caps.maxActiveTunnelsPerSocket) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel active tunnel cap exceeded');
            return;
        }

        if (isV1OpenFrame && authorizedTunnelKeys.has(tunnelKey)) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'tunnel_id_already_open' });
            emitSocketError(socket, 'Server-routed peer tunnel is already open');
            return;
        }

        if (!isV1OpenFrame && !authorizedTunnelKeys.has(tunnelKey)) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'tunnel_not_open' });
            emitSocketError(socket, 'Server-routed peer tunnel frame arrived before an authorized open');
            return;
        }

        if (envelope.v === 1 && envelope.frame.kind === 'open') {
            const payload = envelope.frame.open.relayAuthorization?.payload;
            if (!payload || !consumeRelayAuthorizationGrant({
                grantId: payload.grantId,
                expiresAt: payload.exp,
                nowMs: now,
            })) {
                emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_authorization_invalid' });
                emitSocketError(socket, 'Server-routed peer tunnel relay authorization has already been consumed');
                return;
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
            });
            clearTunnelState(tunnelKey);
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
                });
            } else {
                emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: substreamDenyReason });
            }
            emitSocketError(socket, 'Server-routed peer tunnel substream cap or lifecycle check failed');
            return;
        }

        const decodedBytes = envelope.v === 1 ? frameDecodedBytes(envelope.frame, caps.maxFrameBytes) : decodedBinary?.payloadBytes ?? 0;
        const nextBytes = (bytesByTunnelKey.get(tunnelKey) ?? 0) + decodedBytes;
        if (decodedBytes > caps.maxFrameBytes || nextBytes > caps.maxBytes) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel byte cap exceeded');
            return;
        }

        const startedAt = tunnelStartedAtByKey.get(tunnelKey) ?? now;
        tunnelStartedAtByKey.set(tunnelKey, startedAt);
        if (now - startedAt > caps.maxDurationMs) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel duration cap exceeded');
            return;
        }
        if (!isV1OpenFrame && now - lastActivityAt > caps.maxIdleMs) {
            emitAbort({ io: ctx.io, userId, envelope, tunnelId, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel idle cap exceeded');
            return;
        }

        trackTunnelKeyForSocket(socketTunnelKeys, tunnelKey);
        if (isV1OpenFrame) {
            authorizedTunnelKeys.add(tunnelKey);
            encodingByTunnelKey.set(tunnelKey, selectedOpenEncoding(envelope.frame));
        }
        bytesByTunnelKey.set(tunnelKey, nextBytes);
        tunnelLastActivityAtByKey.set(tunnelKey, now);
        scheduleTunnelTimers(tunnelKey, envelope, tunnelId);
        ctx.io.to(participantRoom(userId, envelope.recipient)).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);

        if (isTerminalFrame) {
            clearTunnelState(tunnelKey);
        }
    });

    socket.on('disconnect', () => {
        for (const tunnelKey of [...socketTunnelKeys]) {
            clearTunnelState(tunnelKey);
        }
        socketTunnelKeys.clear();
    });
}
