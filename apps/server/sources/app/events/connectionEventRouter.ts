import { log } from "@/utils/logging/log";
import { recordEventFanoutDrop, recordEventFanoutEmit } from "@/app/monitoring/metrics/index";
import { readAccountStoredContentCompatibilityForSocket } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { getAccountStoredContentV3SocketRoom } from "@/app/api/socketRooms";
import {
    type ClientConnection,
    type RecipientFilter,
    type UpdatePayload,
    type EphemeralPayload,
} from "./eventPayloadTypes";
import {
    parseCredentialQualifiedSessionDelivery,
    type CredentialQualifiedSessionDeliveryV1,
    type LocalSocketRoomEmitter,
    type SocketRoomBroadcastOperator,
    type SocketRoomEmitter,
    type SocketRoomEventName,
} from "./socketRoomEmitter";
import { buildSessionAccessProjectionSelect, resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import type { Socket } from "socket.io";
import { readSessionAccessAuthenticationFromSocket } from "@/app/session/access/sessionAccessAuthentication";
import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import type { SessionBroadcastContainer } from "@happier-dev/protocol";
import type { VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import type { forwardRpcCall, RpcForwardResult } from '@/app/api/socket/rpc/forwardRpcCall';
import { cancelRpcTarget } from '@/app/api/socket/rpc/cancelRpcTarget';

import {
    getAccountRevocationSocketRoom,
    getApiTokenRevocationSocketRoom,
    getAccountTerminalSocketRoom,
    getAccountSessionSocketRoom,
    getMachineBoundSessionSocketRoom,
    getMachineSocketRoom,
} from "@/app/api/socketRooms";

export type ServerOwnedRpcForwardRequest = Omit<Parameters<typeof forwardRpcCall>[0], 'io'>;
type ServerOwnedRpcForwarder = (request: ServerOwnedRpcForwardRequest) => Promise<RpcForwardResult>;

const MAX_EVENT_FANOUT_METRIC_LABEL_LENGTH = 80;
const SAFE_EVENT_FANOUT_METRIC_LABEL_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const EVENT_FANOUT_PAYLOAD_BYTES_SAMPLE_RATE = 0.01;

type SessionDeliverySocket = Pick<Socket, "id" | "data">;

function normalizeEventFanoutMetricLabel(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_EVENT_FANOUT_METRIC_LABEL_LENGTH) {
        return "other";
    }
    if (!SAFE_EVENT_FANOUT_METRIC_LABEL_PATTERN.test(value)) {
        return "other";
    }
    return value;
}

function resolveEventFanoutPayloadType(payload: any): string {
    return normalizeEventFanoutMetricLabel(payload?.body?.t ?? payload?.type);
}

function estimateEventFanoutPayloadBytes(payload: any): number {
    try {
        return Buffer.byteLength(JSON.stringify(payload));
    } catch {
        return 0;
    }
}

function shouldSampleEventFanoutPayloadBytes(): boolean {
    return Math.random() < EVENT_FANOUT_PAYLOAD_BYTES_SAMPLE_RATE;
}

function projectPayloadForSocket(data: Readonly<{ authTokenKind?: unknown }>, payload: unknown): unknown {
    if (data.authTokenKind !== "api_token" || !payload || typeof payload !== "object") return payload;
    const container = payload as Readonly<Record<string, unknown>>;
    const body = container.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return payload;
    const update = body as Readonly<Record<string, unknown>>;
    if (update.t !== "update-session" || !("access" in update)) return payload;
    const { access: _access, ...viewerBody } = update;
    return { ...container, body: viewerBody };
}

class EventRouter {
    private userConnections = new Map<string, Set<ClientConnection>>();
    private io: SocketRoomEmitter | null = null;
    private serverOwnedRpcForwarder: ServerOwnedRpcForwarder | null = null;
    private machineAccessLossListeners = new Set<(input: Readonly<{ accountId: string; machineId: string }>) => void>();
    private warnedNoIo = false;

    // === CONNECTION MANAGEMENT ===

    addConnection(userId: string, connection: ClientConnection): void {
        if (!this.userConnections.has(userId)) {
            this.userConnections.set(userId, new Set());
        }
        this.userConnections.get(userId)!.add(connection);
    }

    removeConnection(userId: string, connection: ClientConnection): void {
        const connections = this.userConnections.get(userId);
        if (connections) {
            connections.delete(connection);
            if (connections.size === 0) {
                this.userConnections.delete(userId);
            }
        }
    }

    getConnections(userId: string): Set<ClientConnection> | undefined {
        return this.userConnections.get(userId);
    }

    async hasFocusedComputerUi(userId: string): Promise<boolean> {
        const isFocused = (data: Record<string, unknown>) => {
            const focus = data.uiFocus;
            return data.clientType === 'user-scoped'
                && data.clientPurpose === 'sync'
                && typeof focus === 'object'
                && focus !== null
                && 'computer' in focus && focus.computer === true
                && 'focused' in focus && focus.focused === true;
        };
        if (this.io?.in) {
            try {
                const sockets = await this.io.in(`user-scoped:${userId}`).fetchSockets();
                return sockets.some((socket) => isFocused(socket.data));
            } catch (error) {
                // Unknown focus must preserve phone delivery rather than silently mute it.
                log({ module: 'ui-focus', error }, 'Unable to query focused computer UI; preserving push delivery');
                return false;
            }
        }
        return [...(this.userConnections.get(userId) ?? [])].some((connection) => (
            connection.connectionType === 'user-scoped'
            && connection.socket.connected === true
            && isFocused(connection.socket.data)
        ));
    }

    // === SOCKET.IO ADAPTER (ROOM-BASED FANOUT) ===

    setIo(io: SocketRoomEmitter, options: Readonly<{ forwardRpc?: ServerOwnedRpcForwarder }> = {}): void {
        this.io = io;
        this.serverOwnedRpcForwarder = options.forwardRpc ?? null;
    }

    clearIo(): void {
        this.io = null;
        this.serverOwnedRpcForwarder = null;
    }

    /** The live Socket.IO adapter only; domain owners supply their currentness guard. */
    async forwardServerOwnedRpc(request: ServerOwnedRpcForwardRequest): Promise<RpcForwardResult | null> {
        return this.serverOwnedRpcForwarder ? this.serverOwnedRpcForwarder(request) : null;
    }

    cancelServerOwnedRpc(input: Readonly<{ targetSocketId: string; targetRequestId: string }>): void {
        if (this.io && this.serverOwnedRpcForwarder) cancelRpcTarget({ io: this.io, ...input });
    }

    onMachineAccessLoss(listener: (input: Readonly<{ accountId: string; machineId: string }>) => void): () => void {
        this.machineAccessLossListeners.add(listener);
        return () => { this.machineAccessLossListeners.delete(listener); };
    }

    disconnectAccountSockets(accountId: string): void {
        if (this.io) {
            this.io.to([
                getAccountRevocationSocketRoom(accountId),
                `user:${accountId}`,
                `user-machines:${accountId}`,
            ]).disconnectSockets(true);
            return;
        }
        for (const connection of this.userConnections.get(accountId) ?? []) {
            connection.socket.disconnect(true);
        }
    }

    disconnectAccountTerminalSockets(accountId: string): void {
        if (this.io) {
            this.io.to(getAccountTerminalSocketRoom(accountId)).disconnectSockets(true);
            return;
        }
        for (const connection of this.userConnections.get(accountId) ?? []) {
            if (connection.socket.data.authTokenKind === "terminal") connection.socket.disconnect(true);
        }
    }

    disconnectApiTokenSockets(tokenIds: readonly string[]): void {
        if (tokenIds.length === 0) return;
        if (this.io) {
            this.io.to(tokenIds.map(getApiTokenRevocationSocketRoom)).disconnectSockets(true);
            return;
        }
        for (const connections of this.userConnections.values()) {
            for (const connection of connections) {
                const principal: VerifiedApiTokenPrincipal | undefined = connection.socket.data.apiTokenPrincipal;
                if (principal && (tokenIds.includes(principal.credentialId)
                    || (principal.parentTokenId !== null && tokenIds.includes(principal.parentTokenId)))) connection.socket.disconnect(true);
            }
        }
    }

    /** Disconnects exact-resource sockets through the configured cross-node adapter. */
    disconnectMachineAndSessionSockets(params: Readonly<{
        accountId: string;
        machineId: string;
        sessionBindings: readonly Readonly<{ accountId: string; sessionId: string }>[];
    }>): void {
        for (const listener of this.machineAccessLossListeners) listener({ accountId: params.accountId, machineId: params.machineId });
        if (this.io) {
            this.io.to([...new Set([
                getMachineSocketRoom(params.accountId, params.machineId),
                ...params.sessionBindings.map((binding) => getMachineBoundSessionSocketRoom(
                    binding.accountId,
                    binding.sessionId,
                    params.machineId,
                )),
            ])]).disconnectSockets(true);
            return;
        }
        const sessionsByAccount = new Map<string, Set<string>>();
        for (const binding of params.sessionBindings) {
            const sessions = sessionsByAccount.get(binding.accountId) ?? new Set<string>();
            sessions.add(binding.sessionId);
            sessionsByAccount.set(binding.accountId, sessions);
        }
        for (const accountId of new Set([params.accountId, ...sessionsByAccount.keys()])) {
            for (const connection of this.userConnections.get(accountId) ?? []) {
                if (
                    (accountId === params.accountId && connection.connectionType === "machine-scoped" && connection.machineId === params.machineId)
                    || (
                        connection.connectionType === "session-scoped"
                        && connection.machineId === params.machineId
                        && sessionsByAccount.get(accountId)?.has(connection.sessionId)
                    )
                ) {
                    connection.socket.disconnect(true);
                }
            }
        }
    }

    // === EVENT EMISSION METHODS ===

    emitUpdate(params: {
        userId: string;
        payload: UpdatePayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void | Promise<void> {
        return this.emit({
            userId: params.userId,
            eventName: 'update',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    emitEphemeral(params: {
        userId: string;
        payload: EphemeralPayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void | Promise<void> {
        return this.emit({
            userId: params.userId,
            eventName: 'ephemeral',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    emitSessionBroadcast(params: {
        userId: string;
        sessionId: string;
        payload: SessionBroadcastContainer;
    }): void | Promise<void> {
        return this.emit({
            userId: params.userId,
            eventName: "session",
            payload: params.payload,
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
        });
    }

    // === PRIVATE ROUTING LOGIC ===

    private shouldSendToConnection(
        connection: ClientConnection,
        filter: RecipientFilter
    ): boolean {
        switch (filter.type) {
            case 'all-interested-in-session':
                // Send to session-scoped with matching session + all user-scoped
                if (connection.connectionType === 'session-scoped') {
                    if (connection.sessionId !== filter.sessionId) {
                        return false;  // Wrong session
                    }
                } else if (connection.connectionType === 'machine-scoped') {
                    return false;  // Machines don't need session updates
                }
                // user-scoped always gets it
                return true;

            case 'user-scoped-only':
                return connection.connectionType === 'user-scoped';

            case 'machine-scoped-only':
                // Send to user-scoped (mobile/web needs all machine updates) + only the specific machine
                if (connection.connectionType === 'user-scoped') {
                    return true;
                }
                if (connection.connectionType === 'machine-scoped') {
                    return connection.machineId === filter.machineId;
                }
                return false;  // session-scoped doesn't need machine updates

            case 'machine-only':
                return connection.connectionType === 'machine-scoped' && connection.machineId === filter.machineId;

            case 'user-machine-scoped-only':
                return connection.connectionType === 'machine-scoped';

            case 'account-stored-content-v3':
                return readAccountStoredContentCompatibilityForSocket(connection.socket).supportsPluginDataProtocol;

            case 'all-user-authenticated-connections':
                // Send to all connection types (default behavior)
                return true;

            default:
                return false;
        }
    }

    private emit(params: {
        userId: string;
        eventName: SocketRoomEventName;
        payload: any;
        recipientFilter: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void | Promise<void> {
        if (params.recipientFilter.type === "all-interested-in-session") {
            return this.emitToCredentialQualifiedSessionConnections({
                ...params,
                sessionId: params.recipientFilter.sessionId,
            });
        }
        const payloadType = resolveEventFanoutPayloadType(params.payload);
        const shouldSamplePayloadBytes = shouldSampleEventFanoutPayloadBytes();
        const payloadBytes = shouldSamplePayloadBytes ? estimateEventFanoutPayloadBytes(params.payload) : undefined;

        if (this.io) {
            const skipSocketId = params.skipSenderConnection?.socket?.id;
            const target = this.getEmitterTargetForFilter(params.userId, params.recipientFilter);
            const emitter = this.getEmitterForFilter(params.userId, params.recipientFilter);
            if (skipSocketId && typeof (emitter as any).except === "function") {
                (emitter as any).except(skipSocketId).emit(params.eventName, params.payload);
            } else {
                emitter.emit(params.eventName, params.payload);
            }
            recordEventFanoutEmit({
                eventName: params.eventName,
                filterType: params.recipientFilter.type,
                dispatchMode: "room",
                targetKind: "room",
                targetCount: Array.isArray(target) ? target.length : 1,
                payloadType,
                ...(payloadBytes !== undefined ? { payloadBytes } : {}),
            });
            return;
        }

        if (process.env.HAPPY_SOCKET_ROOMS_ONLY === "1") {
            recordEventFanoutDrop({
                eventName: params.eventName,
                reason: "io_unavailable",
            });
            throw new Error("EventRouter: Socket.IO server (io) is not initialized (HAPPY_SOCKET_ROOMS_ONLY=1)");
        }
        if (!this.warnedNoIo) {
            this.warnedNoIo = true;
            log({ module: 'websocket', level: 'warn' }, "EventRouter: io not initialized; falling back to in-memory routing (single-process only)");
        }

        const connections = this.userConnections.get(params.userId);
        if (!connections) {
            recordEventFanoutDrop({
                eventName: params.eventName,
                reason: "no_connections",
            });
            log({ module: 'websocket', level: 'warn' }, `No connections found for user ${params.userId}`);
            return;
        }

        let deliveredCount = 0;
        for (const connection of connections) {
            // Skip message echo
            if (params.skipSenderConnection && connection === params.skipSenderConnection) {
                continue;
            }

            // Apply recipient filter
            if (!this.shouldSendToConnection(connection, params.recipientFilter)) {
                continue;
            }

            connection.socket.emit(params.eventName, params.payload);
            deliveredCount += 1;
        }

        if (deliveredCount === 0) {
            recordEventFanoutDrop({
                eventName: params.eventName,
                reason: "no_matching_connections",
            });
        }
        recordEventFanoutEmit({
            eventName: params.eventName,
            filterType: params.recipientFilter.type,
            dispatchMode: "local",
            targetKind: "connection",
            targetCount: deliveredCount,
            payloadType,
            ...(payloadBytes !== undefined ? { payloadBytes } : {}),
        });
    }

    /**
     * Session content/effects are authorized per admitted socket credential. Account rooms are
     * deliberately not an authorization boundary: one Account may hold two differently-qualified
     * credentials. The Lane 03 owner re-evaluates current provider/link/connection state here.
     */
    private async emitToCredentialQualifiedSessionConnections(params: {
        userId: string;
        sessionId: string;
        eventName: SocketRoomEventName;
        payload: unknown;
        skipSenderConnection?: ClientConnection;
    }): Promise<void> {
        const payloadType = resolveEventFanoutPayloadType(params.payload);
        const payloadBytes = shouldSampleEventFanoutPayloadBytes()
            ? estimateEventFanoutPayloadBytes(params.payload)
            : undefined;
        const skipSocketId = params.skipSenderConnection?.socket.id;
        try {
            // Protected Session delivery requires a live Session authority. The real
            // deletion owner pre-resolves its recipients before deletion and publishes
            // the typed content-free `delete-session` hint through `user-scoped-only`;
            // an arbitrary all-interested payload must never inherit that exception.
            if (!await db.session.findUnique({ where: { id: params.sessionId }, select: { id: true } })) {
                recordEventFanoutDrop({
                    eventName: params.eventName,
                    reason: "no_matching_connections",
                });
                return;
            }
            if (this.io?.sessionDeliveryMode === "forward_only") {
                if (!this.io.forwardCredentialQualifiedSessionDelivery) {
                    throw new Error("Protected Session forwarding is unavailable");
                }
                await this.io.forwardCredentialQualifiedSessionDelivery({
                    v: 1,
                    accountId: params.userId,
                    sessionId: params.sessionId,
                    eventName: params.eventName,
                    payload: params.payload,
                    ...(skipSocketId ? { skipSocketId } : {}),
                });
                return;
            }
            if (this.io?.in) {
                const sockets = await this.io.in([
                    `session:${params.sessionId}:${params.userId}`,
                    `user-scoped:${params.userId}`,
                ]).fetchSockets();
                const deliveredCount = await this.emitToQualifiedSessionSockets({
                    accountId: params.userId,
                    sessionId: params.sessionId,
                    sockets: sockets.filter(socket => socket.id !== skipSocketId
                        && socket.data.userId === params.userId
                        && socket.data.clientType !== "machine-scoped"
                        && (socket.data.clientType !== "session-scoped"
                            || socket.data.sessionId === params.sessionId
                            || socket.data.sessionScopedBinding?.sessionId === params.sessionId)),
                    emit: socket => {
                        this.io!.to(socket.id).emit(params.eventName, projectPayloadForSocket(socket.data, params.payload));
                        return true;
                    },
                });
                recordEventFanoutEmit({
                    eventName: params.eventName,
                    filterType: "all-interested-in-session",
                    dispatchMode: "room",
                    targetKind: "connection",
                    targetCount: deliveredCount,
                    payloadType,
                    ...(payloadBytes !== undefined ? { payloadBytes } : {}),
                });
                return;
            }

            const deliveredCount = await this.emitToQualifiedSessionSockets({
                accountId: params.userId,
                sessionId: params.sessionId,
                sockets: [...this.userConnections.get(params.userId) ?? []]
                    .filter(connection => connection !== params.skipSenderConnection && this.shouldSendToConnection(connection, {
                        type: "all-interested-in-session", sessionId: params.sessionId,
                    }))
                    .map(connection => connection.socket),
                emit: socket => {
                    socket.emit(params.eventName, projectPayloadForSocket(socket.data, params.payload));
                    return true;
                },
            });
            recordEventFanoutEmit({
                eventName: params.eventName,
                filterType: "all-interested-in-session",
                dispatchMode: "local",
                targetKind: "connection",
                targetCount: deliveredCount,
                payloadType,
                ...(payloadBytes !== undefined ? { payloadBytes } : {}),
            });
        } catch (error) {
            recordEventFanoutDrop({ eventName: params.eventName, reason: "no_matching_connections" });
            log({ module: "websocket", level: "warn", sessionId: params.sessionId, error }, "Credential-qualified Session event delivery unavailable");
        }
    }

    /**
     * Re-enters the canonical per-socket access decision on one receiving API node.
     * The forwarded envelope carries routing intent only; socket authentication data
     * and current Session authority are read locally and cannot be supplied by a worker.
     */
    async receiveCredentialQualifiedSessionDelivery(
        localIo: LocalSocketRoomEmitter,
        rawDelivery: unknown,
    ): Promise<void> {
        const delivery = parseCredentialQualifiedSessionDelivery(rawDelivery);
        if (!delivery) {
            recordEventFanoutDrop({ eventName: "update", reason: "no_matching_connections" });
            return;
        }
        try {
            await this.emitToQualifiedSocketsOnReceivingNode(localIo, delivery);
        } catch (error) {
            recordEventFanoutDrop({ eventName: delivery.eventName, reason: "no_matching_connections" });
            log(
                { module: "websocket", level: "warn", sessionId: delivery.sessionId, error },
                "Receiving-node credential-qualified Session delivery unavailable",
            );
        }
    }

    private async emitToQualifiedSocketsOnReceivingNode(
        localIo: LocalSocketRoomEmitter,
        delivery: CredentialQualifiedSessionDeliveryV1,
    ): Promise<void> {
        const sockets = await localIo.in([
            `session:${delivery.sessionId}:${delivery.accountId}`,
            `user-scoped:${delivery.accountId}`,
        ]).fetchSockets();
        const deliveredCount = await this.emitToQualifiedSessionSockets({
            accountId: delivery.accountId,
            sessionId: delivery.sessionId,
            sockets: sockets.filter(socket => socket.id !== delivery.skipSocketId
                && socket.data.userId === delivery.accountId
                && socket.data.clientType !== "machine-scoped"
                && (socket.data.clientType !== "session-scoped"
                    || socket.data.sessionId === delivery.sessionId
                    || socket.data.sessionScopedBinding?.sessionId === delivery.sessionId)),
            emit: socket => {
                try {
                    localIo.to(socket.id).emit(delivery.eventName, projectPayloadForSocket(socket.data, delivery.payload));
                    return true;
                } catch {
                    return false;
                }
            },
        });
        recordEventFanoutEmit({
            eventName: delivery.eventName,
            filterType: "all-interested-in-session",
            dispatchMode: "room",
            targetKind: "connection",
            targetCount: deliveredCount,
            payloadType: resolveEventFanoutPayloadType(delivery.payload),
        });
    }

    /** One delivery snapshot shares structural facts, never a credential's access decision. */
    private async emitToQualifiedSessionSockets<S extends SessionDeliverySocket>(params: Readonly<{
        accountId: string;
        sessionId: string;
        sockets: readonly S[];
        emit: (socket: S) => boolean;
    }>): Promise<number> {
        if (params.sockets.length === 0) return 0;
        const qualifiedSockets = await inTx(async tx => {
            const row = await tx.session.findUnique({
                where: { id: params.sessionId },
                select: buildSessionAccessProjectionSelect(params.accountId),
            });
            const qualified: S[] = [];
            if (!row) return qualified;
            for (const socket of params.sockets) {
                let decision: Awaited<ReturnType<typeof resolveSessionAccessForOperation>>;
                try {
                    decision = await resolveSessionAccessForOperation(tx, {
                        accountId: params.accountId,
                        sessionId: params.sessionId,
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                        row,
                    });
                } catch {
                    // One malformed or stale credential cannot suppress another socket's delivery.
                    continue;
                }
                if (decision.status !== "allowed" || !decision.access.capabilities.readTranscript) continue;
                qualified.push(socket);
            }
            return qualified;
        });
        let deliveredCount = 0;
        for (const socket of qualifiedSockets) {
            if (params.emit(socket)) deliveredCount += 1;
        }
        return deliveredCount;
    }

    private getEmitterTargetForFilter(userId: string, filter: RecipientFilter): string | string[] {
        switch (filter.type) {
            case "all-interested-in-session":
                return [`session:${filter.sessionId}:${userId}`, `user-scoped:${userId}`];
            case "user-scoped-only":
                return `user-scoped:${userId}`;
            case "machine-scoped-only":
                return [`machine:${filter.machineId}:${userId}`, `user-scoped:${userId}`];
            case "machine-only":
                return `machine:${filter.machineId}:${userId}`;
            case "user-machine-scoped-only":
                return `user-machines:${userId}`;
            case "account-stored-content-v3":
                return getAccountStoredContentV3SocketRoom(userId);
            case "all-user-authenticated-connections":
            default:
                return `user:${userId}`;
        }
    }

    private getEmitterForFilter(userId: string, filter: RecipientFilter): SocketRoomBroadcastOperator {
        if (!this.io) {
            throw new Error("EventRouter.getEmitterForFilter called without io");
        }
        return this.io.to(this.getEmitterTargetForFilter(userId, filter));
    }
}

export const eventRouter = new EventRouter();
