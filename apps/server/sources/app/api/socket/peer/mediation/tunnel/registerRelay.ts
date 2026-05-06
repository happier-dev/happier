import {
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    PeerTcpTunnelRelayEnvelopeV1Schema,
    validatePeerTcpTunnelDataFrameCaps,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelRelayEnvelopeV1,
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
const authorizedTunnelKeys = new Set<TunnelKey>();
const bytesByTunnelKey = new Map<TunnelKey, number>();
const tunnelStartedAtByKey = new Map<TunnelKey, number>();
const tunnelLastActivityAtByKey = new Map<TunnelKey, number>();
const tunnelTimersByKey = new Map<TunnelKey, Readonly<{
    idleTimer?: ReturnType<typeof setTimeout>;
    durationTimer?: ReturnType<typeof setTimeout>;
}>>();

function getFrameTunnelId(frame: PeerTcpTunnelFrameV1): string {
    return frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
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

function buildTunnelKey(envelope: PeerTcpTunnelRelayEnvelopeV1, tunnelId: string): TunnelKey {
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
    envelope: PeerTcpTunnelRelayEnvelopeV1;
    reasonCode: string;
}>): void {
    const tunnelId = getFrameTunnelId(input.envelope.frame);
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

function frameDecodedBytes(frame: PeerTcpTunnelFrameV1, maxFrameBytes: number): number {
    if (frame.kind !== 'data') return 0;
    const capped = validatePeerTcpTunnelDataFrameCaps({
        frame,
        maxEncodedFrameBytes: maxFrameBytes,
        maxDecodedPayloadBytes: maxFrameBytes,
    });
    return capped.ok ? capped.decodedBytes : maxFrameBytes + 1;
}

function clearTunnelState(tunnelKey: TunnelKey): void {
    const timers = tunnelTimersByKey.get(tunnelKey);
    if (timers?.idleTimer) clearTimeout(timers.idleTimer);
    if (timers?.durationTimer) clearTimeout(timers.durationTimer);
    tunnelTimersByKey.delete(tunnelKey);
    authorizedTunnelKeys.delete(tunnelKey);
    bytesByTunnelKey.delete(tunnelKey);
    tunnelStartedAtByKey.delete(tunnelKey);
    tunnelLastActivityAtByKey.delete(tunnelKey);
}

export function registerPeerTcpTunnelRelaySocketHandler(
    userId: string,
    socket: TunnelRelaySocket,
    ctx: Readonly<{ io: TunnelRelayIo } & Partial<PeerTcpTunnelRelayCaps>>,
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
        envelope: PeerTcpTunnelRelayEnvelopeV1,
    ): void {
        const existing = tunnelTimersByKey.get(tunnelKey);
        if (existing?.idleTimer) clearTimeout(existing.idleTimer);
        if (existing?.durationTimer) clearTimeout(existing.durationTimer);
        const now = Date.now();
        const startedAt = tunnelStartedAtByKey.get(tunnelKey) ?? now;
        const durationRemainingMs = Math.max(1, caps.maxDurationMs - Math.max(0, now - startedAt));
        const idleTimer = setTimeout(() => {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'relay_cap_exceeded' });
            socketTunnelKeys.delete(tunnelKey);
            clearTunnelState(tunnelKey);
        }, Math.max(1, caps.maxIdleMs));
        const durationTimer = setTimeout(() => {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'relay_cap_exceeded' });
            socketTunnelKeys.delete(tunnelKey);
            clearTunnelState(tunnelKey);
        }, durationRemainingMs);
        idleTimer.unref?.();
        durationTimer.unref?.();
        tunnelTimersByKey.set(tunnelKey, { idleTimer, durationTimer });
    }

    socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (raw: unknown) => {
        const parsed = PeerTcpTunnelRelayEnvelopeV1Schema.safeParse(raw);
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

        const tunnelId = getFrameTunnelId(envelope.frame);
        const tunnelKey = buildTunnelKey(envelope, tunnelId);

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

        const policyDenyReason = validateOpenFramePolicy({ envelope, caps });
        if (policyDenyReason) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: policyDenyReason });
            emitSocketError(socket, 'Server-routed peer tunnel destination policy denied the tunnel');
            return;
        }

        const directionDenyReason = validateRelayFrameDirection(envelope);
        if (directionDenyReason) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: directionDenyReason });
            emitSocketError(socket, 'Server-routed peer tunnel frame direction does not match sender binding');
            return;
        }

        if (!socketTunnelKeys.has(tunnelKey) && socketTunnelKeys.size >= caps.maxActiveTunnelsPerSocket) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel active tunnel cap exceeded');
            return;
        }

        if (envelope.frame.kind === 'open' && authorizedTunnelKeys.has(tunnelKey)) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'tunnel_id_already_open' });
            emitSocketError(socket, 'Server-routed peer tunnel is already open');
            return;
        }

        if (envelope.frame.kind !== 'open' && !authorizedTunnelKeys.has(tunnelKey)) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'tunnel_not_open' });
            emitSocketError(socket, 'Server-routed peer tunnel frame arrived before an authorized open');
            return;
        }

        const decodedBytes = frameDecodedBytes(envelope.frame, caps.maxFrameBytes);
        const nextBytes = (bytesByTunnelKey.get(tunnelKey) ?? 0) + decodedBytes;
        if (decodedBytes > caps.maxFrameBytes || nextBytes > caps.maxBytes) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel byte cap exceeded');
            return;
        }

        const now = Date.now();
        const startedAt = tunnelStartedAtByKey.get(tunnelKey) ?? now;
        tunnelStartedAtByKey.set(tunnelKey, startedAt);
        if (now - startedAt > caps.maxDurationMs) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel duration cap exceeded');
            return;
        }
        const lastActivityAt = tunnelLastActivityAtByKey.get(tunnelKey) ?? now;
        if (envelope.frame.kind !== 'open' && now - lastActivityAt > caps.maxIdleMs) {
            emitAbort({ io: ctx.io, userId, envelope, reasonCode: 'relay_cap_exceeded' });
            emitSocketError(socket, 'Server-routed peer tunnel idle cap exceeded');
            return;
        }

        socketTunnelKeys.add(tunnelKey);
        if (envelope.frame.kind === 'open') {
            authorizedTunnelKeys.add(tunnelKey);
        }
        bytesByTunnelKey.set(tunnelKey, nextBytes);
        tunnelLastActivityAtByKey.set(tunnelKey, now);
        scheduleTunnelTimers(tunnelKey, envelope);
        ctx.io.to(participantRoom(userId, envelope.recipient)).emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, envelope);

        if (envelope.frame.kind === 'close' || envelope.frame.kind === 'abort') {
            socketTunnelKeys.delete(tunnelKey);
            clearTunnelState(tunnelKey);
        }
    });

    socket.on('disconnect', () => {
        for (const tunnelKey of socketTunnelKeys) {
            clearTunnelState(tunnelKey);
        }
        socketTunnelKeys.clear();
    });
}
