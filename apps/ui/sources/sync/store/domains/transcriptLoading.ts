import type { StoreGet, StoreSet } from './_shared';
import type { ExternalSessionsRpcErrorCode } from '@happier-dev/protocol';

import type { ExternalSessionTranscriptUnavailableReason } from '@/sync/runtime/external/externalSessionTranscriptAuthority';

export type SessionTranscriptLoadIssue =
    | Readonly<{
        kind: 'authority_unavailable';
        reason: ExternalSessionTranscriptUnavailableReason;
    }>
    | Readonly<{
        kind: 'read_failed';
        errorCode: ExternalSessionsRpcErrorCode;
    }>
    | Readonly<{
        kind: 'source_discontinuity';
    }>;

/**
 * Transient per-session transcript loading signals.
 *
 * Today this domain owns the single canonical "newer catch-up in flight" signal
 * surfaced by the bottom-anchored {@link
 * '@/components/sessions/transcript/CatchUpProgressOverlay'.CatchUpProgressOverlay}.
 *
 * When a background-working session is reopened we show the last-known-good
 * transcript and then silently catch up to newer activity. The catch-up flows in
 * sync (`loadNewerMessages`, `catchUpExternalSessionMessages`,
 * `catchUpLoadedExternalSessionsOnResume`, the socket-reconnect
 * `invalidateMessagesForSession`) bracket their work with {@link
 * TranscriptLoadingDomain.beginSessionCatchUpNewer} / {@link
 * TranscriptLoadingDomain.endSessionCatchUpNewer}. The signal is ref-counted so
 * overlapping catch-up flows for one session compose correctly and only settle
 * once every flow has finished.
 *
 * Fail-closed: an absent/zero count reads as "not catching up", so an unknown
 * session never shows a spinner.
 */
export type TranscriptLoadingDomain = {
    /** Per-session ref-count of in-flight newer catch-up flows. */
    sessionCatchUpNewerInFlight: Record<string, number>;
    /**
     * Per-session tail-contiguity floor (MAIN chain). Set while a tail-reset
     * discontinuity is open (see `sessionMessagesTailDiscontinuity`): only messages at or
     * above the floor are contiguous with the live tail; the transcript's tail display
     * must not render loaded-but-disconnected older content below it. Absent = no
     * discontinuity, the full loaded set is tail-contiguous.
     */
    sessionTailContiguousFloorSeq: Record<string, number>;
    /** Last non-authoritative initial transcript outcome, absent after authoritative success. */
    sessionTranscriptLoadIssues: Record<string, SessionTranscriptLoadIssue>;
    /** True while at least one newer catch-up flow is running for the session. */
    isSessionCatchingUpNewer: (sessionId: string) => boolean;
    /** Mark a newer catch-up flow as started for the session (ref-counted). */
    beginSessionCatchUpNewer: (sessionId: string) => void;
    /** Mark a newer catch-up flow as finished for the session (ref-counted). */
    endSessionCatchUpNewer: (sessionId: string) => void;
    /** Read the tail-contiguity floor for the session's main chain (null = none). */
    getSessionTailContiguousFloorSeq: (sessionId: string) => number | null;
    /** Set (positive seq) or clear (null) the tail-contiguity floor for the session. */
    setSessionTailContiguousFloorSeq: (sessionId: string, floorSeq: number | null) => void;
    /** Read the last non-authoritative initial transcript outcome for this session. */
    getSessionTranscriptLoadIssue: (sessionId: string) => SessionTranscriptLoadIssue | null;
    /** Replace or clear the last non-authoritative initial transcript outcome. */
    setSessionTranscriptLoadIssue: (sessionId: string, issue: SessionTranscriptLoadIssue | null) => void;
};

export function createTranscriptLoadingDomain<S extends TranscriptLoadingDomain>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): TranscriptLoadingDomain {
    return {
        sessionCatchUpNewerInFlight: {},
        sessionTailContiguousFloorSeq: {},
        sessionTranscriptLoadIssues: {},
        isSessionCatchingUpNewer: (sessionId) => {
            if (!sessionId) return false;
            return (get().sessionCatchUpNewerInFlight[sessionId] ?? 0) > 0;
        },
        getSessionTailContiguousFloorSeq: (sessionId) => {
            if (!sessionId) return null;
            const floorSeq = get().sessionTailContiguousFloorSeq[sessionId];
            return typeof floorSeq === 'number' && Number.isFinite(floorSeq) && floorSeq > 0
                ? floorSeq
                : null;
        },
        getSessionTranscriptLoadIssue: (sessionId) => {
            if (!sessionId) return null;
            return get().sessionTranscriptLoadIssues[sessionId] ?? null;
        },
        setSessionTranscriptLoadIssue: (sessionId, issue) => {
            if (!sessionId) return;
            set((state) => {
                if (issue === null) {
                    if (!(sessionId in state.sessionTranscriptLoadIssues)) return state;
                    const next = { ...state.sessionTranscriptLoadIssues };
                    delete next[sessionId];
                    return { ...state, sessionTranscriptLoadIssues: next };
                }
                const current = state.sessionTranscriptLoadIssues[sessionId];
                if (
                    current?.kind === issue.kind
                    && (current.kind !== 'authority_unavailable'
                        || (issue.kind === 'authority_unavailable' && current.reason === issue.reason))
                    && (current.kind !== 'read_failed'
                        || (issue.kind === 'read_failed' && current.errorCode === issue.errorCode))
                ) {
                    return state;
                }
                return {
                    ...state,
                    sessionTranscriptLoadIssues: {
                        ...state.sessionTranscriptLoadIssues,
                        [sessionId]: issue,
                    },
                };
            });
        },
        setSessionTailContiguousFloorSeq: (sessionId, floorSeq) => {
            if (!sessionId) return;
            set((state) => {
                const normalized = typeof floorSeq === 'number' && Number.isFinite(floorSeq) && floorSeq > 0
                    ? Math.trunc(floorSeq)
                    : null;
                const current = state.sessionTailContiguousFloorSeq[sessionId];
                if (normalized === null) {
                    if (!(sessionId in state.sessionTailContiguousFloorSeq)) return state;
                    const next = { ...state.sessionTailContiguousFloorSeq };
                    delete next[sessionId];
                    return { ...state, sessionTailContiguousFloorSeq: next };
                }
                if (current === normalized) return state;
                return {
                    ...state,
                    sessionTailContiguousFloorSeq: {
                        ...state.sessionTailContiguousFloorSeq,
                        [sessionId]: normalized,
                    },
                };
            });
        },
        beginSessionCatchUpNewer: (sessionId) => {
            if (!sessionId) return;
            set((state) => ({
                ...state,
                sessionCatchUpNewerInFlight: {
                    ...state.sessionCatchUpNewerInFlight,
                    [sessionId]: (state.sessionCatchUpNewerInFlight[sessionId] ?? 0) + 1,
                },
            }));
        },
        endSessionCatchUpNewer: (sessionId) => {
            if (!sessionId) return;
            set((state) => {
                const current = state.sessionCatchUpNewerInFlight[sessionId] ?? 0;
                if (current <= 0) {
                    // Unbalanced end: nothing to release. Keep the map pruned.
                    if (!(sessionId in state.sessionCatchUpNewerInFlight)) return state;
                    const next = { ...state.sessionCatchUpNewerInFlight };
                    delete next[sessionId];
                    return { ...state, sessionCatchUpNewerInFlight: next };
                }
                const nextCount = current - 1;
                const next = { ...state.sessionCatchUpNewerInFlight };
                if (nextCount <= 0) {
                    delete next[sessionId];
                } else {
                    next[sessionId] = nextCount;
                }
                return { ...state, sessionCatchUpNewerInFlight: next };
            });
        },
    };
}
