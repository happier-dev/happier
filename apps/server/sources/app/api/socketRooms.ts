export type SocketClientType = "session-scoped" | "user-scoped" | "machine-scoped";

export function getAccountStoredContentV3SocketRoom(userId: string): string {
    if (!userId) {
        throw new Error("getAccountStoredContentV3SocketRoom: userId is required");
    }
    return `account-stored-content-v3:${userId}`;
}

export function getSocketRooms(params: {
    userId: string;
    clientType: SocketClientType;
    sessionId?: string | undefined;
    machineId?: string | undefined;
    includeAccountStoredContentV3Room?: boolean | undefined;
}): string[] {
    if (!params.userId) {
        throw new Error("getSocketRooms: userId is required");
    }

    const rooms: string[] = [];

    if (params.clientType === "user-scoped") {
        rooms.push(`user:${params.userId}`);
        rooms.push(`user-scoped:${params.userId}`);
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

        // Per-account session room (safe for recipient-specific updates).
        rooms.push(`session:${params.sessionId}:${params.userId}`);
    }

    if (params.clientType === "machine-scoped") {
        if (!params.machineId) {
            throw new Error("getSocketRooms: machineId is required for machine-scoped clients");
        }
        // Machine daemons should not subscribe to the generic user room. That room is the fanout target
        // for "all authenticated connections" events, and Bun's long-lived socket clients retain native
        // memory aggressively under websocket churn. Keep machine daemons on dedicated machine rooms.
        rooms.push(`user-machines:${params.userId}`);
        rooms.push(`machine:${params.machineId}:${params.userId}`);
    }

    if (params.includeAccountStoredContentV3Room) {
        rooms.push(getAccountStoredContentV3SocketRoom(params.userId));
    }

    return rooms;
}
