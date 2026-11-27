import { Server } from "socket.io";
import { RELEASED_CONNECTED_SERVICE_IDS, readConnectedServiceReaderSupport } from "@happier-dev/protocol";
import { CURRENT_CONNECTED_SERVICE_READER_ROOM, getSessionUpdateTargets, getSocketRooms, RELEASED_CONNECTED_SERVICE_READER_ROOM, type SocketFanoutTarget } from "../api/socketRooms";
import { projectConnectedServiceUpdateForReader } from "./projectConnectedServiceUpdateForReader";
import { type HappierSocketData } from "../api/socket/socketData";
import {
    socketEmissionPayloadBytesHistogram,
    socketEmissionsCounter,
} from "@/app/monitoring/metrics2";
import { log } from "@/utils/logging/log";
import {
    type ClientConnection,
    type RecipientFilter,
    type UpdatePayload,
    type EphemeralPayload,
} from "./eventPayloadTypes";

const MAX_SOCKET_METRIC_LABEL_LENGTH = 80;
const SAFE_SOCKET_METRIC_LABEL_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const SOCKET_PAYLOAD_BYTES_SAMPLE_RATE = 100;

function normalizeSocketMetricLabel(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_SOCKET_METRIC_LABEL_LENGTH) {
        return "other";
    }
    if (!SAFE_SOCKET_METRIC_LABEL_PATTERN.test(value)) {
        return "other";
    }
    return value;
}

function resolveSocketPayloadType(payload: any): string {
    return normalizeSocketMetricLabel(payload?.body?.t ?? payload?.type);
}

function estimateSocketPayloadBytes(payload: any): number {
    try {
        return Buffer.byteLength(JSON.stringify(payload));
    } catch {
        return 0;
    }
}

function shouldObserveSocketPayloadBytes(): boolean {
    return Math.random() < (1 / SOCKET_PAYLOAD_BYTES_SAMPLE_RATE);
}

function reachesFanoutTarget(rooms: string[], target: SocketFanoutTarget): boolean {
    const excluded: readonly string[] = typeof target.except === "string" ? [target.except] : (target.except ?? []);
    return excluded.every(room => !rooms.includes(room)) && target.rooms.some(room => rooms.includes(room));
}

function toTargetEmitters(io: Server, targets: ReadonlyArray<SocketFanoutTarget>): ReadonlyArray<ReturnType<Server["to"]>> {
    return targets.map(target => {
        if (target.except === undefined) {
            return io.to(target.rooms);
        }
        return io.to(target.rooms).except(target.except);
    });
}

type ResolvedRecipientFilter =
    | Exclude<RecipientFilter, { type: 'all-interested-in-session' }>
    | { type: 'session-rooms'; targets: ReadonlyArray<SocketFanoutTarget> };

class EventRouter {
    private userConnections = new Map<string, Set<ClientConnection>>();
    private io: Server | null = null;
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

    /** Query the account's live socket owner, including other Redis-adapter workers. */
    async hasFocusedComputerUi(userId: string): Promise<boolean> {
        const isFocused = (data: HappierSocketData) => data.clientType === 'user-scoped'
            && data.clientPurpose === 'sync'
            && data.uiFocus?.computer === true
            && data.uiFocus.focused === true;
        if (this.io) {
            try {
                const sockets = await this.io.in(`user-scoped:${userId}`).fetchSockets();
                return sockets.some((socket) => isFocused(socket.data as HappierSocketData));
            } catch (error) {
                // Unknown focus must preserve phone delivery rather than silently mute it.
                log({ module: 'ui-focus', error }, 'Unable to query focused computer UI; preserving push delivery');
                return false;
            }
        }
        return [...(this.userConnections.get(userId) ?? [])].some((connection) => (
            connection.connectionType === 'user-scoped'
            && connection.socket.connected === true
            && isFocused(connection.socket.data as HappierSocketData)
        ));
    }

    // === SOCKET.IO ADAPTER (ROOM-BASED FANOUT) ===

    setIo(io: Server): void {
        this.io = io;
    }

    clearIo(): void {
        this.io = null;
    }

    // === EVENT EMISSION METHODS ===

    emitUpdate(params: {
        userId: string;
        payload: UpdatePayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void {
        this.emit({
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
    }): void {
        const { type } = params.payload;
        this.emit({
            userId: params.userId,
            eventName: 'ephemeral',
            excludeLiveTranscriptDisabled: type === 'transcript-stream-segment'
                || type === 'transcript-stream-segment-delta'
                || type === 'direct-session-transcript-delta',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    // === PRIVATE ROUTING LOGIC ===

    private shouldSendToConnection(
        connection: ClientConnection,
        filter: ResolvedRecipientFilter
    ): boolean {
        switch (filter.type) {
            case 'session-rooms': {
                const rooms = getSocketRooms({
                    ...connection,
                    clientType: connection.connectionType,
                });
                return filter.targets.some(target => reachesFanoutTarget(rooms, target));
            }

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

            case 'all-user-authenticated-connections':
                // Send to all connection types (default behavior)
                return true;

            default:
                return false;
        }
    }

    private emit(params: {
        userId: string;
        eventName: 'update' | 'ephemeral';
        payload: any;
        recipientFilter: RecipientFilter;
        excludeLiveTranscriptDisabled?: boolean;
        skipSenderConnection?: ClientConnection;
    }): void {
        const emissionLabels = {
            event_name: params.eventName,
            recipient_filter: params.recipientFilter.type,
            payload_type: resolveSocketPayloadType(params.payload),
        };
        socketEmissionsCounter.inc(emissionLabels);
        if (shouldObserveSocketPayloadBytes()) {
            socketEmissionPayloadBytesHistogram.observe(emissionLabels, estimateSocketPayloadBytes(params.payload));
        }

        const { recipientFilter } = params;
        const filter: ResolvedRecipientFilter = recipientFilter.type === 'all-interested-in-session'
            ? {
                type: 'session-rooms',
                targets: getSessionUpdateTargets(params.userId, recipientFilter.sessionId, params.excludeLiveTranscriptDisabled ?? false),
            }
            : recipientFilter;

        if (this.io) {
            const skipSocketId = params.skipSenderConnection?.socket?.id;
            const emitters = this.getEmittersForFilter(params.userId, filter);
            if (params.eventName === "update") {
                const legacyPayload = projectConnectedServiceUpdateForReader(params.payload, RELEASED_CONNECTED_SERVICE_IDS);
                if (legacyPayload !== params.payload) {
                    // Intersect the existing recipient rooms with reader support
                    // through exclusion, retaining distributed adapter fanout.
                    const emitToReaders = (excludedRoom: string, payload: UpdatePayload) => {
                        for (const emitter of emitters) {
                            const readerEmitter = emitter.except(excludedRoom);
                            (skipSocketId ? readerEmitter.except(skipSocketId) : readerEmitter).emit(params.eventName, payload);
                        }
                    };
                    emitToReaders(CURRENT_CONNECTED_SERVICE_READER_ROOM, legacyPayload);
                    emitToReaders(RELEASED_CONNECTED_SERVICE_READER_ROOM, params.payload);
                    return;
                }
            }
            for (const emitter of emitters) {
                (skipSocketId ? emitter.except(skipSocketId) : emitter).emit(params.eventName, params.payload);
            }
            return;
        }

        if (process.env.HAPPY_SOCKET_ROOMS_ONLY === "1") {
            throw new Error("EventRouter: Socket.IO server (io) is not initialized (HAPPY_SOCKET_ROOMS_ONLY=1)");
        }
        if (!this.warnedNoIo) {
            this.warnedNoIo = true;
            log({ module: 'websocket', level: 'warn' }, "EventRouter: io not initialized; falling back to in-memory routing (single-process only)");
        }

        const connections = this.userConnections.get(params.userId);
        if (!connections) {
            log({ module: 'websocket', level: 'warn' }, `No connections found for user ${params.userId}`);
            return;
        }

        for (const connection of connections) {
            // Skip message echo
            if (params.skipSenderConnection && connection === params.skipSenderConnection) {
                continue;
            }

            // Apply recipient filter
            if (!this.shouldSendToConnection(connection, filter)) {
                continue;
            }

            const payload = params.eventName === "update"
                ? projectConnectedServiceUpdateForReader(params.payload, readConnectedServiceReaderSupport((connection.socket.data as HappierSocketData).connectedServiceIds))
                : params.payload;
            connection.socket.emit(params.eventName, payload);
        }
    }

    private getEmittersForFilter(userId: string, filter: ResolvedRecipientFilter): ReadonlyArray<ReturnType<Server["to"]>> {
        const io = this.io;
        if (!io) {
            throw new Error("EventRouter.getEmittersForFilter called without io");
        }

        switch (filter.type) {
            case "session-rooms":
                return toTargetEmitters(io, filter.targets);
            case "user-scoped-only":
                return [io.to(`user-scoped:${userId}`)];
            case "machine-scoped-only": {
                const rooms = [`machine:${filter.machineId}:${userId}`, `user-scoped:${userId}`];
                return [io.to(rooms)];
            }
            case "machine-only":
                return [io.to(`machine:${filter.machineId}:${userId}`)];
            case "user-machine-scoped-only":
                return [io.to(`user-machines:${userId}`)];
            case "all-user-authenticated-connections":
                return [io.to(`user:${userId}`)];
            default:
                return [io.to(`user:${userId}`)];
        }
    }
}

export const eventRouter = new EventRouter();
