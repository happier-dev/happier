import type { StoreGet, StoreSet } from './_shared';
import type { SessionMessagesTailBoundary } from '@/sync/runtime/sessionMessagesTailDiscontinuity';
import type { ExternalSessionsRpcErrorCode } from '@happier-dev/protocol/sessions/external/rpcErrorCodes';

import type { ExternalSessionTranscriptUnavailableReason } from '@/sync/runtime/external/externalSessionTranscriptAuthority';

export type SessionTranscriptLoadIssue =
    | Readonly<{
        kind: 'authority_unavailable';
        reason: ExternalSessionTranscriptUnavailableReason;
    }>
    | Readonly<{
        kind: 'read_failed';
        errorCode: ExternalSessionsRpcErrorCode
            | 'session_encryption_not_found'
            | 'scoped_session_encryption_unavailable'
            | 'http_error'
            | 'invalid_response'
            | 'decryption_failed'
            | 'network_error'
            | 'rpc_error'
            | 'request_failed';
        httpStatus?: number;
        causeCode?: string;
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
     * Per-session tail-contiguity boundary (MAIN chain), projected by the one
     * `sessionMessagesTailDiscontinuity` owner. Sequences identify hosted islands;
     * materialized message IDs identify opaque-source islands. Absent = no
     * discontinuity, the full loaded set is tail-contiguous.
     */
    sessionTailContiguousBoundary: Record<string, SessionMessagesTailBoundary>;
    /** Last non-authoritative initial transcript outcome, absent after authoritative success. */
    sessionTranscriptLoadIssues: Record<string, SessionTranscriptLoadIssue>;
    /** True while at least one newer catch-up flow is running for the session. */
    isSessionCatchingUpNewer: (sessionId: string) => boolean;
    /** Mark a newer catch-up flow as started for the session (ref-counted). */
    beginSessionCatchUpNewer: (sessionId: string) => void;
    /** Mark a newer catch-up flow as finished for the session (ref-counted). */
    endSessionCatchUpNewer: (sessionId: string) => void;
    /** Read the tail-contiguity boundary for the session's main chain (null = none). */
    getSessionTailContiguousBoundary: (sessionId: string) => SessionMessagesTailBoundary | null;
    /** Sequence-only convenience reader; the canonical boundary owns the state. */
    getSessionTailContiguousFloorSeq: (sessionId: string) => number | null;
    /** Set or clear (null) the tail-contiguity display boundary for the session. */
    setSessionTailContiguousBoundary: (sessionId: string, boundary: SessionMessagesTailBoundary | null) => void;
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
        sessionTailContiguousBoundary: {},
        sessionTranscriptLoadIssues: {},
        isSessionCatchingUpNewer: (sessionId) => {
            if (!sessionId) return false;
            return (get().sessionCatchUpNewerInFlight[sessionId] ?? 0) > 0;
        },
        getSessionTailContiguousBoundary: (sessionId) => {
            if (!sessionId) return null;
            return get().sessionTailContiguousBoundary[sessionId] ?? null;
        },
        getSessionTailContiguousFloorSeq: (sessionId) => {
            const boundary = get().getSessionTailContiguousBoundary(sessionId);
            return boundary?.kind === 'seq' ? boundary.seq : null;
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
                        || (issue.kind === 'read_failed'
                            && current.errorCode === issue.errorCode
                            && current.httpStatus === issue.httpStatus
                            && current.causeCode === issue.causeCode))
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
        setSessionTailContiguousBoundary: (sessionId, boundary) => {
            if (!sessionId) return;
            set((state) => {
                const normalized = boundary?.kind === 'seq'
                    ? (Number.isFinite(boundary.seq) && boundary.seq > 0 ? { kind: 'seq' as const, seq: Math.trunc(boundary.seq) } : null)
                    : boundary;
                const current = state.sessionTailContiguousBoundary[sessionId];
                if (normalized === null) {
                    if (!(sessionId in state.sessionTailContiguousBoundary)) return state;
                    const next = { ...state.sessionTailContiguousBoundary };
                    delete next[sessionId];
                    return { ...state, sessionTailContiguousBoundary: next };
                }
                if (current === normalized || (current?.kind === 'seq' && normalized.kind === 'seq' && current.seq === normalized.seq)
                    || (current?.kind === 'messageIds' && normalized.kind === 'messageIds'
                        && current.messageIds.length === normalized.messageIds.length
                        && current.messageIds.every((id, index) => id === normalized.messageIds[index]))) return state;
                return {
                    ...state,
                    sessionTailContiguousBoundary: {
                        ...state.sessionTailContiguousBoundary,
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
