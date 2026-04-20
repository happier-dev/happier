type SessionScannerSessionInfoLike = Readonly<{
    sessionId: string;
}>;

export function createSessionCoordinator(params: Readonly<{
    sessionId: string | null;
}>) {
    const finishedSessions = new Set<string>();
    const pendingSessions = new Set<string>();
    const suppressInitialReplaySessions = new Set<string>();
    let currentSessionId: string | null = null;

    if (params.sessionId) {
        currentSessionId = params.sessionId;
        suppressInitialReplaySessions.add(params.sessionId);
    }

    return {
        getCurrentSessionId(): string | null {
            return currentSessionId;
        },
        collectSessionsToSync(watcherSessionIds: Iterable<string>): string[] {
            const sessions: string[] = [];
            for (const sessionId of pendingSessions) {
                sessions.push(sessionId);
            }
            if (currentSessionId && !pendingSessions.has(currentSessionId)) {
                sessions.push(currentSessionId);
            }
            for (const sessionId of watcherSessionIds) {
                if (!sessions.includes(sessionId)) {
                    sessions.push(sessionId);
                }
            }
            return sessions;
        },
        resolveInitialReplayEmission(sessionId: string, previousCursor: string | null): boolean {
            const shouldEmitMessages = !(previousCursor === null && suppressInitialReplaySessions.has(sessionId));
            if (previousCursor === null) {
                suppressInitialReplaySessions.delete(sessionId);
            }
            return shouldEmitMessages;
        },
        markSessionsSynced(sessionIds: Iterable<string>): void {
            for (const sessionId of sessionIds) {
                if (!pendingSessions.has(sessionId)) continue;
                pendingSessions.delete(sessionId);
                finishedSessions.add(sessionId);
            }
        },
        onNewSession(arg: string | SessionScannerSessionInfoLike): Readonly<{
            shouldInvalidate: boolean;
            shouldWarmSession: boolean;
        }> {
            const sessionId = typeof arg === 'string' ? arg : arg.sessionId;

            if (currentSessionId === sessionId) {
                return {
                    shouldInvalidate: false,
                    shouldWarmSession: false,
                };
            }

            if (finishedSessions.has(sessionId) || pendingSessions.has(sessionId)) {
                return {
                    shouldInvalidate: false,
                    shouldWarmSession: false,
                };
            }

            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            currentSessionId = sessionId;

            return {
                shouldInvalidate: true,
                shouldWarmSession: true,
            };
        },
        shutdown(): void {
            currentSessionId = null;
            pendingSessions.clear();
            finishedSessions.clear();
            suppressInitialReplaySessions.clear();
        },
    };
}
