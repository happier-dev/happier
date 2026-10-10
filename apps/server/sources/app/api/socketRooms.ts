export type SocketClientType = "session-scoped" | "user-scoped" | "machine-scoped";

export function getApiTokenRevocationSocketRoom(tokenId: string): string {
    if (!tokenId) throw new Error("getApiTokenRevocationSocketRoom: tokenId is required");
    return `api-token-revocation:${tokenId}`;
}

export function getAccountRevocationSocketRoom(userId: string): string {
    if (!userId) throw new Error("getAccountRevocationSocketRoom: userId is required");
    return `account-revocation:${userId}`;
}

export function getAccountTerminalSocketRoom(accountId: string): string {
    if (!accountId) throw new Error("getAccountTerminalSocketRoom: accountId is required");
    return `account-terminal:${accountId}`;
}

export function getMachineSocketRoom(userId: string, machineId: string): string {
    if (!userId || !machineId) throw new Error("getMachineSocketRoom: userId and machineId are required");
    return `machine:${machineId}:${userId}`;
}

export function getMachineInstallationSocketRoom(userId: string, machineId: string, installationId: string): string {
    if (!installationId) throw new Error('getMachineInstallationSocketRoom: installationId is required');
    return `${getMachineSocketRoom(userId, machineId)}:installation:${installationId}`;
}

export function getAccountSessionSocketRoom(userId: string, sessionId: string): string {
    if (!userId || !sessionId) throw new Error("getAccountSessionSocketRoom: userId and sessionId are required");
    return `session:${sessionId}:${userId}`;
}

export function getMachineBoundSessionSocketRoom(
    userId: string,
    sessionId: string,
    machineId: string,
): string {
    if (!userId || !sessionId || !machineId) {
        throw new Error("getMachineBoundSessionSocketRoom: userId, sessionId, and machineId are required");
    }
    return `session:${sessionId}:machine:${machineId}:${userId}`;
}

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
    includeUserRoomForSessionScoped?: boolean | undefined;
    includeUserMachinesRoom?: boolean | undefined;
}): string[] {
    return [
        getAccountRevocationSocketRoom(params.userId),
        ...getProtectedSocketRooms(params),
    ];
}

export function getProtectedSocketRooms(params: {
    userId: string;
    clientType: SocketClientType;
    sessionId?: string | undefined;
    machineId?: string | undefined;
    includeAccountStoredContentV3Room?: boolean | undefined;
    includeUserRoomForSessionScoped?: boolean | undefined;
    includeUserMachinesRoom?: boolean | undefined;
}): string[] {
    if (!params.userId) {
        throw new Error("getProtectedSocketRooms: userId is required");
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
        if (params.includeUserRoomForSessionScoped !== false) {
            rooms.push(`user:${params.userId}`);
        }
        // Important: `session:${sessionId}` is a shared room across participants and must never receive per-account `update`
        // containers (they contain per-account cursors and may contain recipient-specific data). We still join it for future
        // broadcast-safe session events.
        rooms.push(`session:${params.sessionId}`);

        // Per-account session room (safe for recipient-specific updates).
        rooms.push(getAccountSessionSocketRoom(params.userId, params.sessionId));
        if (params.machineId) {
            rooms.push(getMachineBoundSessionSocketRoom(
                params.userId,
                params.sessionId,
                params.machineId,
            ));
        }
    }

    if (params.clientType === "machine-scoped") {
        if (!params.machineId) {
            throw new Error("getSocketRooms: machineId is required for machine-scoped clients");
        }
        // Machine daemons should not subscribe to the generic user room. That room is the fanout target
        // for "all authenticated connections" events, and Bun's long-lived socket clients retain native
        // memory aggressively under websocket churn. Keep machine daemons on dedicated machine rooms.
        if (params.includeUserMachinesRoom !== false) {
            rooms.push(`user-machines:${params.userId}`);
        }
        rooms.push(getMachineSocketRoom(params.userId, params.machineId));
    }

    if (params.includeAccountStoredContentV3Room) {
        rooms.push(getAccountStoredContentV3SocketRoom(params.userId));
    }

    return rooms;
}
