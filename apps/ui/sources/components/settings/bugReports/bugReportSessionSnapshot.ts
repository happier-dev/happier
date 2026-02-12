type SessionLike = {
    id: string;
    createdAt?: number;
    updatedAt?: number;
    agent?: string;
    machineId?: string;
    permissionMode?: string | null;
    modelMode?: string | null;
};

type SessionMessageLike = {
    id: string;
    kind: string;
    createdAt?: number;
    localId?: string | null;
};

type SessionPendingLike = {
    messages?: Array<{ id?: string; localId?: string | null; createdAt?: number }>;
};

export type LatestSessionSnapshot = {
    sessionId: string;
    createdAt: number | null;
    updatedAt: number | null;
    agent: string | null;
    machineId: string | null;
    permissionMode: string | null;
    modelMode: string | null;
    messageCount: number;
    pendingCount: number;
    recentMessages: Array<{
        id: string;
        kind: string;
        createdAt: number | null;
        localId: string | null;
    }>;
};

function normalizeTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compareMessageChronology(left: SessionMessageLike, right: SessionMessageLike): number {
    const leftCreatedAt = normalizeTimestamp(left.createdAt);
    const rightCreatedAt = normalizeTimestamp(right.createdAt);
    if (leftCreatedAt !== null && rightCreatedAt !== null && leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
    }
    if (leftCreatedAt !== null && rightCreatedAt === null) return -1;
    if (leftCreatedAt === null && rightCreatedAt !== null) return 1;
    return String(left.id).localeCompare(String(right.id));
}

export function buildLatestSessionSnapshot(input: {
    sessions: Record<string, SessionLike>;
    sessionMessages: Record<string, { messages?: SessionMessageLike[] }>;
    sessionPending: Record<string, SessionPendingLike>;
}): LatestSessionSnapshot | null {
    const sessions = Object.values(input.sessions);
    if (sessions.length === 0) return null;
    const latestSession = sessions
        .slice()
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0];
    if (!latestSession) return null;

    const sessionMessages = input.sessionMessages[latestSession.id]?.messages ?? [];
    const pendingMessages = input.sessionPending[latestSession.id]?.messages ?? [];

    const recentMessages = sessionMessages
        .slice()
        .sort(compareMessageChronology)
        .slice(-30)
        .map((message) => ({
            id: String(message.id),
            kind: String(message.kind),
            createdAt: normalizeTimestamp(message.createdAt),
            localId: typeof message.localId === 'string' ? message.localId : null,
        }));

    return {
        sessionId: latestSession.id,
        createdAt: normalizeTimestamp(latestSession.createdAt),
        updatedAt: normalizeTimestamp(latestSession.updatedAt),
        agent: typeof latestSession.agent === 'string' ? latestSession.agent : null,
        machineId: typeof latestSession.machineId === 'string' ? latestSession.machineId : null,
        permissionMode: typeof latestSession.permissionMode === 'string' ? latestSession.permissionMode : null,
        modelMode: typeof latestSession.modelMode === 'string' ? latestSession.modelMode : null,
        messageCount: sessionMessages.length,
        pendingCount: pendingMessages.length,
        recentMessages,
    };
}
