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
}>;

export function createDeferredTranscriptState(): DeferredTranscriptState {
    return {
        knownRemoteSeqBySessionId: {},
        deferredDurableSeqBySessionId: {},
        staleMessageIdsBySessionId: {},
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
    const existing = remoteState.staleMessageIdsBySessionId[sessionId] ?? [];
    if (existing.includes(marker.messageId)) return remoteState;
    return {
        ...remoteState,
        staleMessageIdsBySessionId: {
            ...remoteState.staleMessageIdsBySessionId,
            [sessionId]: [...existing, marker.messageId],
        },
    };
}

export function hasStaleTranscriptMarkers(state: DeferredTranscriptState, sessionId: string): boolean {
    return (state.staleMessageIdsBySessionId[sessionId]?.length ?? 0) > 0;
}

export function readDeferredTranscriptDurableSeq(state: DeferredTranscriptState, sessionId: string): number | null {
    return normalizeSeq(state.deferredDurableSeqBySessionId[sessionId]);
}

export function clearDeferredTranscriptStateForSession(
    state: DeferredTranscriptState,
    sessionId: string,
): DeferredTranscriptState {
    if (
        !(sessionId in state.deferredDurableSeqBySessionId)
        && !(sessionId in state.staleMessageIdsBySessionId)
    ) {
        return state;
    }
    const { [sessionId]: _deferred, ...deferredDurableSeqBySessionId } = state.deferredDurableSeqBySessionId;
    const { [sessionId]: _stale, ...staleMessageIdsBySessionId } = state.staleMessageIdsBySessionId;
    return {
        ...state,
        deferredDurableSeqBySessionId,
        staleMessageIdsBySessionId,
    };
}
