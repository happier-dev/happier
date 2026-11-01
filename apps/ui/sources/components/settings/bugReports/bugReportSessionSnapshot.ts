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

export type SelectedSessionSnapshot = {
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

export function buildSelectedSessionSnapshot(input: {
    sessionId: string;
    sessions: Record<string, SessionLike>;
    sessionMessages: Record<string, {
        messages?: SessionMessageLike[];
        messageIdsOldestFirst?: string[];
        messagesById?: Record<string, SessionMessageLike | undefined>;
    }>;
    sessionPending: Record<string, SessionPendingLike>;
}): SelectedSessionSnapshot | null {
    const selectedSession = input.sessions[input.sessionId];
    if (!selectedSession) return null;

    const sessionMessagesState = input.sessionMessages[selectedSession.id];
    const sessionMessages = (() => {
        if (!sessionMessagesState) return [];
        if (Array.isArray(sessionMessagesState.messages)) return sessionMessagesState.messages;
        const ids = Array.isArray(sessionMessagesState.messageIdsOldestFirst)
            ? sessionMessagesState.messageIdsOldestFirst
            : [];
        const byId = sessionMessagesState.messagesById ?? {};
        return ids.map((id) => byId[id]).filter(Boolean) as SessionMessageLike[];
    })();
    const pendingMessages = input.sessionPending[selectedSession.id]?.messages ?? [];

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
        sessionId: selectedSession.id,
        createdAt: normalizeTimestamp(selectedSession.createdAt),
        updatedAt: normalizeTimestamp(selectedSession.updatedAt),
        agent: typeof selectedSession.agent === 'string' ? selectedSession.agent : null,
        machineId: typeof selectedSession.machineId === 'string' ? selectedSession.machineId : null,
        permissionMode: typeof selectedSession.permissionMode === 'string' ? selectedSession.permissionMode : null,
        modelMode: typeof selectedSession.modelMode === 'string' ? selectedSession.modelMode : null,
        messageCount: sessionMessages.length,
        pendingCount: pendingMessages.length,
        recentMessages,
    };
}
