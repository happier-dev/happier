export type HydrationApplyFlushReason = 'size' | 'timer' | 'required' | 'final' | 'manual';

/** Shared Session publication scheduler for list hydration and by-ID completions. */
export function createHydrationApplyQueue<T>(params: {
    apply: (batch: T[], reason: HydrationApplyFlushReason) => void;
    batchSize?: number;
    /** Omitted when already-admitted rows can coalesce in the next microtask. */
    flushDelayMs?: number;
    shouldScheduleFlush?: () => boolean;
    flushRequiredRowsImmediately?: () => boolean;
    coalesceRequiredRows?: () => boolean;
}) {
    let pending: T[] = [];
    let cancelScheduledFlush: (() => void) | null = null;
    let scheduledReason: HydrationApplyFlushReason | null = null;

    const flush = (reason: HydrationApplyFlushReason = 'manual'): void => {
        cancelScheduledFlush?.();
        cancelScheduledFlush = null;
        scheduledReason = null;
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        params.apply(batch, reason);
    };

    const schedule = (reason: HydrationApplyFlushReason): void => {
        if (cancelScheduledFlush) {
            if (reason !== 'size' || scheduledReason === 'size') return;
            cancelScheduledFlush();
        }
        scheduledReason = reason;
        if (params.flushDelayMs === undefined) {
            let cancelled = false;
            cancelScheduledFlush = () => { cancelled = true; };
            queueMicrotask(() => { if (!cancelled) flush(reason); });
        } else {
            const timer = setTimeout(() => flush(reason), params.flushDelayMs);
            cancelScheduledFlush = () => clearTimeout(timer);
        }
    };

    return {
        getPendingCount: () => pending.length,
        enqueue: (row: T): void => {
            pending.push(row);
            if (params.shouldScheduleFlush?.() === false) return;
            if (params.batchSize !== undefined && pending.length >= params.batchSize) {
                if (params.flushRequiredRowsImmediately?.()) flush('size');
                else schedule(params.coalesceRequiredRows?.() ? 'timer' : 'size');
            } else {
                schedule('timer');
            }
        },
        flush,
    };
}
