export type SocketClientType = "session-scoped" | "user-scoped" | "machine-scoped";

export function getSocketRooms(params: {
    userId: string;
    clientType: SocketClientType;
    sessionId?: string | undefined;
    machineId?: string | undefined;
}): string[] {
    if (!params.userId) {
        throw new Error("getSocketRooms: userId is required");
    }

    const rooms: string[] = [`user:${params.userId}`];

    if (params.clientType === "user-scoped") {
        rooms.push(`user-scoped:${params.userId}`);
    }

    if (params.clientType === "session-scoped") {
        if (!params.sessionId) {
            throw new Error("getSocketRooms: sessionId is required for session-scoped clients");
        }
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
        // Per-account machine room (do not use a shared `machine:${machineId}` room).
        rooms.push(`machine:${params.machineId}:${params.userId}`);
    }

    return rooms;
}
