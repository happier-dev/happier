export type DeferredTranscriptUpdateType = 'new-message' | 'message-updated';

export type DeferredTranscriptMarker = Readonly<{
    updateType: DeferredTranscriptUpdateType;
    seq: number | null;
    messageId?: string;
}>;

export type DeferredTranscriptState = Readonly<{
    knownRemoteSeqBySessionId: Readonly<Record<string, number>>;
    deferredDurableSeqBySessionId: Readonly<Record<string, number>>;
    staleMessageIdsBySessionId: Readonly<Record<string, readonly string[]>>;
    // Lowest seq among rows edited while hidden — the lower bound for the targeted refetch
    // region (refetch newer from `minSeq - 1`) so reopening repairs the edited rows without
    // wiping paginated older history.
    staleMinSeqBySessionId: Readonly<Record<string, number>>;
}>;

export function createDeferredTranscriptState(): DeferredTranscriptState {
    return {
        knownRemoteSeqBySessionId: {},
        deferredDurableSeqBySessionId: {},
        staleMessageIdsBySessionId: {},
        staleMinSeqBySessionId: {},
    };
}

function normalizeSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

export function markDeferredTranscriptRemoteSeq(
    state: DeferredTranscriptState,
    sessionId: string,
    seq: number | null | undefined,
): DeferredTranscriptState {
    const normalizedSeq = normalizeSeq(seq);
    if (!sessionId || normalizedSeq === null) return state;
    const prev = state.knownRemoteSeqBySessionId[sessionId] ?? 0;
    if (normalizedSeq <= prev) return state;
    return {
        ...state,
        knownRemoteSeqBySessionId: {
            ...state.knownRemoteSeqBySessionId,
            [sessionId]: normalizedSeq,
        },
    };
}

export function markTranscriptDeferred(
    state: DeferredTranscriptState,
    sessionId: string,
    marker: DeferredTranscriptMarker,
): DeferredTranscriptState {
    const normalizedSeq = normalizeSeq(marker.seq);
    if (!sessionId || normalizedSeq === null) return state;
    const remoteState = markDeferredTranscriptRemoteSeq(state, sessionId, normalizedSeq);
    const prev = remoteState.deferredDurableSeqBySessionId[sessionId] ?? 0;
    if (normalizedSeq <= prev) return remoteState;
    return {
        ...remoteState,
        deferredDurableSeqBySessionId: {
            ...remoteState.deferredDurableSeqBySessionId,
            [sessionId]: normalizedSeq,
        },
    };
}

export function markTranscriptStale(
    state: DeferredTranscriptState,
    sessionId: string,
    marker: DeferredTranscriptMarker,
): DeferredTranscriptState {
    const remoteState = markTranscriptDeferred(state, sessionId, marker);
    if (!sessionId || !marker.messageId) return remoteState;
    const normalizedSeq = normalizeSeq(marker.seq);
    const existingMinSeq = remoteState.staleMinSeqBySessionId[sessionId];
    const nextMinSeq = normalizedSeq === null
        ? existingMinSeq
        : (existingMinSeq === undefined ? normalizedSeq : Math.min(existingMinSeq, normalizedSeq));
    const staleMinSeqBySessionId = nextMinSeq === existingMinSeq
        ? remoteState.staleMinSeqBySessionId
        : { ...remoteState.staleMinSeqBySessionId, ...(nextMinSeq !== undefined ? { [sessionId]: nextMinSeq } : {}) };
    const existing = remoteState.staleMessageIdsBySessionId[sessionId] ?? [];
    if (existing.includes(marker.messageId)) {
        return staleMinSeqBySessionId === remoteState.staleMinSeqBySessionId
            ? remoteState
            : { ...remoteState, staleMinSeqBySessionId };
    }
    return {
        ...remoteState,
        staleMessageIdsBySessionId: {
            ...remoteState.staleMessageIdsBySessionId,
            [sessionId]: [...existing, marker.messageId],
        },
        staleMinSeqBySessionId,
    };
}

export function hasStaleTranscriptMarkers(state: DeferredTranscriptState, sessionId: string): boolean {
    return (state.staleMessageIdsBySessionId[sessionId]?.length ?? 0) > 0;
}

export function readStaleTranscriptMessageIds(
    state: DeferredTranscriptState,
    sessionId: string,
): readonly string[] {
    return state.staleMessageIdsBySessionId[sessionId] ?? [];
}

export function readStaleTranscriptMinSeq(
    state: DeferredTranscriptState,
    sessionId: string,
): number | null {
    return normalizeSeq(state.staleMinSeqBySessionId[sessionId]);
}

export function readDeferredTranscriptDurableSeq(state: DeferredTranscriptState, sessionId: string): number | null {
    return normalizeSeq(state.deferredDurableSeqBySessionId[sessionId]);
}

/**
 * Remove only stale rows which a targeted refetch actually normalized. This
 * deliberately leaves the generic deferred-newer cursor intact, and retains a
 * conservative stale lower bound while any exact row remains unresolved.
 */
export function clearResolvedStaleTranscriptMessageIds(
    state: DeferredTranscriptState,
    sessionId: string,
    resolvedMessageIds: ReadonlySet<string>,
): DeferredTranscriptState {
    if (!sessionId || resolvedMessageIds.size === 0) return state;
    const existing = state.staleMessageIdsBySessionId[sessionId] ?? [];
    if (existing.length === 0) return state;

    const remaining = existing.filter((messageId) => !resolvedMessageIds.has(messageId));
    if (remaining.length === existing.length) return state;
    if (remaining.length > 0) {
        return {
            ...state,
            staleMessageIdsBySessionId: {
                ...state.staleMessageIdsBySessionId,
                [sessionId]: remaining,
            },
        };
    }

    const { [sessionId]: _stale, ...staleMessageIdsBySessionId } = state.staleMessageIdsBySessionId;
    const { [sessionId]: _staleMinSeq, ...staleMinSeqBySessionId } = state.staleMinSeqBySessionId;
    return {
        ...state,
        staleMessageIdsBySessionId,
        staleMinSeqBySessionId,
    };
}

export function clearDeferredTranscriptStateForSession(
    state: DeferredTranscriptState,
    sessionId: string,
): DeferredTranscriptState {
    if (
        !(sessionId in state.deferredDurableSeqBySessionId)
        && !(sessionId in state.staleMessageIdsBySessionId)
        && !(sessionId in state.staleMinSeqBySessionId)
    ) {
        return state;
    }
    const { [sessionId]: _deferred, ...deferredDurableSeqBySessionId } = state.deferredDurableSeqBySessionId;
    const { [sessionId]: _stale, ...staleMessageIdsBySessionId } = state.staleMessageIdsBySessionId;
    const { [sessionId]: _staleMinSeq, ...staleMinSeqBySessionId } = state.staleMinSeqBySessionId;
    return {
        ...state,
        deferredDurableSeqBySessionId,
        staleMessageIdsBySessionId,
        staleMinSeqBySessionId,
    };
}
