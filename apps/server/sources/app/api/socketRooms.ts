import { ConnectedServiceIdSchema, readConnectedServiceReaderSupport } from "@happier-dev/protocol";

export type SocketClientType = "session-scoped" | "user-scoped" | "machine-scoped";

export const RELEASED_CONNECTED_SERVICE_READER_ROOM = "connected-services-reader:released";
export const CURRENT_CONNECTED_SERVICE_READER_ROOM = "connected-services-reader:current";

export function getConnectedServiceReaderRoom(raw: unknown): string {
    const supportedIds = readConnectedServiceReaderSupport(raw);
    return ConnectedServiceIdSchema.options.every(serviceId => supportedIds.includes(serviceId))
        ? CURRENT_CONNECTED_SERVICE_READER_ROOM
        : RELEASED_CONNECTED_SERVICE_READER_ROOM;
}

function userScopedRoom(userId: string): string {
    return `user-scoped:${userId}`;
}

function sessionUpdateRoom(userId: string, sessionId: string): string {
    // Update containers carry per-account cursors and can contain recipient-specific data.
    return `session:${sessionId}:${userId}`;
}

function narrowerSessionInterestRoom(userId: string): string {
    return `narrow-session-interest:${userId}`;
}

function accountSocketSessionInterestRoom(userId: string, sessionId: string): string {
    return `account-socket-session-interest:${sessionId}:${userId}`;
}

function liveTranscriptDisabledRoom(userId: string): string {
    return `live-transcript-disabled:${userId}`;
}

export interface SocketFanoutTarget {
    rooms: string[];
    except?: string | string[];
}

export function getSessionUpdateTargets(
    userId: string,
    sessionId: string,
    excludeLiveTranscriptDisabled: boolean,
): ReadonlyArray<SocketFanoutTarget> {
    // Keep the released rooms reachable during mixed relay-worker deployments.
    // Narrowed account sockets are excluded from the first send and can only match the second.
    const narrow = narrowerSessionInterestRoom(userId);
    const passive = excludeLiveTranscriptDisabled ? liveTranscriptDisabledRoom(userId) : undefined;
    return [
        { rooms: [sessionUpdateRoom(userId, sessionId), userScopedRoom(userId)], except: passive ? [narrow, passive] : narrow },
        { rooms: [accountSocketSessionInterestRoom(userId, sessionId)], except: passive },
    ];
}

export function getSocketRooms(params: {
    userId: string;
    clientType: SocketClientType;
    sessionId?: string | undefined;
    sessionUpdateInterest?: string | undefined;
    liveTranscriptDisabled?: boolean | undefined;
    machineId?: string | undefined;
    connectedServiceIds?: unknown;
}): string[] {
    if (!params.userId) {
        throw new Error("getSocketRooms: userId is required");
    }

    const rooms: string[] = [];

    if (params.clientType === "user-scoped") {
        rooms.push(`user:${params.userId}`);
        rooms.push(userScopedRoom(params.userId));
        if (params.sessionUpdateInterest) {
            rooms.push(narrowerSessionInterestRoom(params.userId));
            rooms.push(accountSocketSessionInterestRoom(params.userId, params.sessionUpdateInterest));
        }
        if (params.liveTranscriptDisabled) {
            rooms.push(liveTranscriptDisabledRoom(params.userId));
        }
    }

    if (params.clientType === "session-scoped") {
        if (!params.sessionId) {
            throw new Error("getSocketRooms: sessionId is required for session-scoped clients");
        }
        rooms.push(`user:${params.userId}`);
        // Important: `session:${sessionId}` is a shared room across participants and must never receive per-account `update`
        // containers (they contain per-account cursors and may contain recipient-specific data). We still join it for future
        // broadcast-safe session events.
        rooms.push(`session:${params.sessionId}`);
        rooms.push(sessionUpdateRoom(params.userId, params.sessionId));
    }

    if (params.clientType === "machine-scoped") {
        if (!params.machineId) {
            throw new Error("getSocketRooms: machineId is required for machine-scoped clients");
        }
        // Machine daemons should not subscribe to the generic user room. That room is the fanout target
        // for "all authenticated connections" events, and Bun's long-lived socket clients retain native
        // memory aggressively under websocket churn. Keep machine daemons on the dedicated per-machine room.
        rooms.push(`user-machines:${params.userId}`);
        rooms.push(`machine:${params.machineId}:${params.userId}`);
    }

    // Reader rooms are exclusion cohorts only; emission remains scoped to the
    // original account/session/machine rooms, preserving participant isolation.
    rooms.push(getConnectedServiceReaderRoom(params.connectedServiceIds));
    return rooms;
}
