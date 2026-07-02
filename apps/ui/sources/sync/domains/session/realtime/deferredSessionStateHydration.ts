export type DeferredSessionStateHydrationState = Readonly<{
    sessionIds: ReadonlySet<string>;
}>;

export function createDeferredSessionStateHydrationState(): DeferredSessionStateHydrationState {
    return { sessionIds: new Set<string>() };
}

function normalizeSessionId(sessionId: string): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
}

export function markSessionStateHydrationDeferred(
    state: DeferredSessionStateHydrationState,
    sessionId: string,
): DeferredSessionStateHydrationState {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || state.sessionIds.has(normalizedSessionId)) return state;
    return { sessionIds: new Set([...state.sessionIds, normalizedSessionId]) };
}

export function hasDeferredSessionStateHydration(
    state: DeferredSessionStateHydrationState,
    sessionId: string,
): boolean {
    const normalizedSessionId = normalizeSessionId(sessionId);
    return Boolean(normalizedSessionId && state.sessionIds.has(normalizedSessionId));
}

export function clearDeferredSessionStateHydration(
    state: DeferredSessionStateHydrationState,
    sessionId: string,
): DeferredSessionStateHydrationState {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !state.sessionIds.has(normalizedSessionId)) return state;
    const nextSessionIds = new Set(state.sessionIds);
    nextSessionIds.delete(normalizedSessionId);
    return { sessionIds: nextSessionIds };
}
