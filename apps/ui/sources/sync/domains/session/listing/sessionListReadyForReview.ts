import type { PrimaryTurnStatusV1, SessionRuntimeActivityState } from '@happier-dev/protocol';

export type SessionListReadyForReviewInput = Readonly<{
    seq?: number | null;
    meaningfulActivityAt?: number | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    latestReadyEventSeq?: number | null;
    lastViewedSessionSeq?: number | null;
    runtimeActivityState?: SessionRuntimeActivityState | null;
    runtimeActivityActiveCount?: number | null;
}>;

export const SESSION_LIST_TERMINAL_ACTIVITY_SKEW_MS = 1_000;

export function isSessionListReadyForReview(input: SessionListReadyForReviewInput): boolean {
    // Losing observation of previously reported work is not evidence that it finished.
    if ((input.runtimeActivityActiveCount ?? 0) > 0 && input.runtimeActivityState !== 'idle') return false;
    return hasUnseenSessionTurnCompletion(input);
}

export function hasUnseenSessionTurnCompletion(input: SessionListReadyForReviewInput): boolean {
    const lastViewedSeq = normalizeSeq(input.lastViewedSessionSeq) ?? 0;
    const readyEventSeq = normalizeSeq(input.latestReadyEventSeq);
    if (readyEventSeq !== null) {
        return readyEventSeq > lastViewedSeq;
    }
    if (input.latestTurnStatus !== 'completed') {
        return false;
    }
    const latestTurnStatusObservedAt = normalizeSeq(input.latestTurnStatusObservedAt);
    const meaningfulActivityAt = normalizeSeq(input.meaningfulActivityAt);
    if (
        latestTurnStatusObservedAt !== null
        && meaningfulActivityAt !== null
        && meaningfulActivityAt > latestTurnStatusObservedAt + SESSION_LIST_TERMINAL_ACTIVITY_SKEW_MS
    ) {
        return false;
    }
    const sessionSeq = normalizeSeq(input.seq);
    return sessionSeq !== null && sessionSeq > lastViewedSeq;
}

function normalizeSeq(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}
