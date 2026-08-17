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
import type { SocketRoomBroadcastOperator, SocketRoomEmitter } from "./socketRoomEmitter";

const MAX_EVENT_FANOUT_METRIC_LABEL_LENGTH = 80;
const SAFE_EVENT_FANOUT_METRIC_LABEL_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const EVENT_FANOUT_PAYLOAD_BYTES_SAMPLE_RATE = 0.01;

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

class EventRouter {
    private userConnections = new Map<string, Set<ClientConnection>>();
    private io: SocketRoomEmitter | null = null;
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

    // === SOCKET.IO ADAPTER (ROOM-BASED FANOUT) ===

    setIo(io: SocketRoomEmitter): void {
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
        this.emit({
            userId: params.userId,
            eventName: 'ephemeral',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
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
        eventName: 'update' | 'ephemeral';
        payload: any;
        recipientFilter: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): void {
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
