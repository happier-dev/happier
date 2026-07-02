import type {
    SessionBulkActionProgressListener,
    SessionBulkActionProgressSnapshot,
} from './sessionBulkActionTypes';

type MutableProgressState = {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cancelled: number;
};

function toSnapshot(state: MutableProgressState): SessionBulkActionProgressSnapshot {
    const completed = state.succeeded + state.failed + state.skipped + state.cancelled;
    const status = completed === 0 && state.running === 0
        ? 'idle'
        : state.cancelled > 0 && completed === state.total
            ? 'cancelled'
            : completed === state.total
                ? 'complete'
                : 'running';

    return {
        total: state.total,
        queued: state.queued,
        running: state.running,
        succeeded: state.succeeded,
        failed: state.failed,
        skipped: state.skipped,
        cancelled: state.cancelled,
        completed,
        status,
    };
}

export type SessionBulkActionProgressTracker = Readonly<{
    snapshot: () => SessionBulkActionProgressSnapshot;
    start: () => void;
    succeed: () => void;
    fail: () => void;
    skip: () => void;
    cancel: () => void;
}>;

function completeSlot(state: MutableProgressState): void {
    if (state.running > 0) {
        state.running -= 1;
        return;
    }
    state.queued = Math.max(0, state.queued - 1);
}

export function createSessionBulkActionProgressTracker(params: Readonly<{
    total: number;
    initiallySkipped?: number;
    onProgress?: SessionBulkActionProgressListener;
}>): SessionBulkActionProgressTracker {
    const initiallySkipped = Math.max(0, Math.min(params.total, Math.trunc(params.initiallySkipped ?? 0)));
    const state: MutableProgressState = {
        total: params.total,
        queued: Math.max(0, params.total - initiallySkipped),
        running: 0,
        succeeded: 0,
        failed: 0,
        skipped: initiallySkipped,
        cancelled: 0,
    };

    const emit = () => {
        params.onProgress?.(toSnapshot(state));
    };

    return {
        snapshot: () => toSnapshot(state),
        start: () => {
            state.queued = Math.max(0, state.queued - 1);
            state.running += 1;
            emit();
        },
        succeed: () => {
            state.running = Math.max(0, state.running - 1);
            state.succeeded += 1;
            emit();
        },
        fail: () => {
            state.running = Math.max(0, state.running - 1);
            state.failed += 1;
            emit();
        },
        skip: () => {
            completeSlot(state);
            state.skipped += 1;
            emit();
        },
        cancel: () => {
            completeSlot(state);
            state.cancelled += 1;
            emit();
        },
    };
}
