type SessionRpcAvailabilitySource = Readonly<{
    sessions: Readonly<Record<string, Readonly<{ active?: boolean }> | undefined>>;
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, Readonly<{ active?: boolean }> | undefined>> | undefined>>;
}>;

/** The same exact-Home Session carrier fact for hooks and request-time readers. */
export function resolveSessionRpcAvailabilityState(state: SessionRpcAvailabilitySource, sessionId: string | null, serverId?: string | null): Readonly<{
    sessionExists: boolean;
    sessionRpcAvailable: boolean;
}> {
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const session = sessionId
        ? normalizedServerId ? state.sessionListRowsByServerId[normalizedServerId]?.[sessionId] : state.sessions[sessionId]
        : null;
    const sessionExists = Boolean(session);
    return { sessionExists, sessionRpcAvailable: sessionExists && session?.active !== false };
}
