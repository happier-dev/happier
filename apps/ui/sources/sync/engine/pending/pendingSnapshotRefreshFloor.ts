/**
 * Trailing-edge sampling floor for server-driven pending snapshot refreshes (#856).
 *
 * A reconcile burst — server pushes bumping pendingVersion, each re-triggering the session's
 * refresh through `fetchPendingMessages` — collapses to one reconcile per floor window per
 * session, plus one trailing reconcile that lands the burst's last trigger. The incident measured
 * 10+ reads inside 300ms (~33 reads/s) against a single session, so a 1s floor bounds the read
 * rate while the trailing edge keeps convergence at one window of latency.
 *
 * This floor deliberately sits at the reconcile entry (`fetchPendingMessages`), NOT at the queue's
 * read owner (`fetchAndApplyPendingMessagesV2`): the read owner serves custody-fenced corrective
 * reads (encryption becoming available, transport retirement, acknowledgement repair) that must
 * issue immediately, while the confirming read after a local queue write bypasses this entry
 * entirely and stays immediate by construction.
 */
import { fireAndForget } from '@/utils/system/fireAndForget';

export const PENDING_SNAPSHOT_REFRESH_FLOOR_MS = 1_000;

type TimerHandle = ReturnType<typeof setTimeout>;

type PendingSnapshotRefreshFloorSessionState = {
    lastReconcileStartedAtMs: number | null;
    trailingReconcileTimer: TimerHandle | null;
};

export function createPendingSnapshotRefreshFloor(): Readonly<{
    sample: (sessionId: string, reconcile: () => Promise<void>) => Promise<void>;
}> {
    const statesBySessionId = new Map<string, PendingSnapshotRefreshFloorSessionState>();

    const startReconcile = (sessionId: string, reconcile: () => Promise<void>): Promise<void> => {
        const state = statesBySessionId.get(sessionId);
        if (state) state.lastReconcileStartedAtMs = Date.now();
        return reconcile();
    };

    const sample = (sessionId: string, reconcile: () => Promise<void>): Promise<void> => {
        let state = statesBySessionId.get(sessionId);
        if (state === undefined) {
            state = { lastReconcileStartedAtMs: null, trailingReconcileTimer: null };
            statesBySessionId.set(sessionId, state);
        }
        const nowMs = Date.now();
        if (
            state.lastReconcileStartedAtMs !== null
            && nowMs - state.lastReconcileStartedAtMs < PENDING_SNAPSHOT_REFRESH_FLOOR_MS
        ) {
            // Inside the floor window one trailing reconcile lands the burst. The timer re-runs
            // the full reconcile thunk, so scope guards, outbox replay, and every capture fact
            // are recomputed at fire time rather than at schedule time.
            if (state.trailingReconcileTimer === null) {
                state.trailingReconcileTimer = setTimeout(() => {
                    const currentState = statesBySessionId.get(sessionId);
                    if (currentState) currentState.trailingReconcileTimer = null;
                    // fireAndForget mirrors the pre-floor caller's failure surface: a rejected
                    // reconcile here must surface as a tagged error, not a bare unhandled
                    // rejection from a timer the caller no longer awaits.
                    fireAndForget(startReconcile(sessionId, reconcile), {
                        tag: 'pendingSnapshotRefreshFloor.trailingReconcile',
                    });
                }, PENDING_SNAPSHOT_REFRESH_FLOOR_MS - (nowMs - state.lastReconcileStartedAtMs));
            }
            return Promise.resolve();
        }
        // A reconcile starting now supersedes any still-deferred trailing reconcile: it recomputes
        // everything the deferred run would have landed.
        if (state.trailingReconcileTimer !== null) {
            clearTimeout(state.trailingReconcileTimer);
            state.trailingReconcileTimer = null;
        }
        return startReconcile(sessionId, reconcile);
    };

    return { sample };
}
