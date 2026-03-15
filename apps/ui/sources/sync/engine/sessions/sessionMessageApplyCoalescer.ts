import type { NormalizedMessage } from '@/sync/typesRaw';

export type SessionMessageApplyCoalescerConfig = Readonly<{
    enabled: boolean;
    windowMs: number;
    maxBatchSize: number;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

type SessionQueueState = {
    queued: NormalizedMessage[];
    timer: TimerHandle | null;
};

export function createSessionMessageApplyCoalescer(params: Readonly<{
    getConfig: () => SessionMessageApplyCoalescerConfig;
    applyBatch: (sessionId: string, messages: NormalizedMessage[]) => void;
    onBatchApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
}>): Readonly<{
    enqueue: (sessionId: string, messages: NormalizedMessage[]) => void;
    flush: (sessionId: string) => void;
    flushAll: () => void;
    getQueuedMaxSeq: (sessionId: string) => number;
}> {
    const queues = new Map<string, SessionQueueState>();

    function getOrCreateQueue(sessionId: string): SessionQueueState {
        const existing = queues.get(sessionId);
        if (existing) return existing;
        const created: SessionQueueState = { queued: [], timer: null };
        queues.set(sessionId, created);
        return created;
    }

    function clearFlushTimer(state: SessionQueueState): void {
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
    }

    function applyImmediate(sessionId: string, messages: NormalizedMessage[], maxBatchSize: number): void {
        if (messages.length === 0) return;
        if (maxBatchSize <= 0) {
            params.applyBatch(sessionId, messages);
            params.onBatchApplied?.(sessionId, messages);
            return;
        }

        for (let i = 0; i < messages.length; i += maxBatchSize) {
            const batch = messages.slice(i, i + maxBatchSize);
            params.applyBatch(sessionId, batch);
            params.onBatchApplied?.(sessionId, batch);
        }
    }

    function scheduleFlush(sessionId: string, state: SessionQueueState, windowMs: number): void {
        if (state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            flush(sessionId);
        }, windowMs);
    }

    function flush(sessionId: string): void {
        const config = params.getConfig();
        const state = queues.get(sessionId);
        if (!state || state.queued.length === 0) return;

        clearFlushTimer(state);

        const maxBatchSize = Math.max(1, Math.trunc(config.maxBatchSize));
        const batch = state.queued.splice(0, maxBatchSize);
        params.applyBatch(sessionId, batch);
        params.onBatchApplied?.(sessionId, batch);

        if (state.queued.length === 0) {
            queues.delete(sessionId);
            return;
        }

        const windowMs = Math.max(0, Math.trunc(config.windowMs));
        if (config.enabled && windowMs > 0) {
            scheduleFlush(sessionId, state, windowMs);
            return;
        }

        // Coalescing is disabled (or window is zero): drain synchronously in bounded batches.
        applyImmediate(sessionId, state.queued.splice(0, state.queued.length), maxBatchSize);
        queues.delete(sessionId);
    }

    function enqueue(sessionId: string, messages: NormalizedMessage[]): void {
        if (messages.length === 0) return;

        const config = params.getConfig();
        const maxBatchSize = Math.max(1, Math.trunc(config.maxBatchSize));
        const windowMs = Math.max(0, Math.trunc(config.windowMs));

        if (!config.enabled || windowMs <= 0) {
            applyImmediate(sessionId, messages, maxBatchSize);
            return;
        }

        const state = getOrCreateQueue(sessionId);
        state.queued.push(...messages);

        if (state.queued.length >= maxBatchSize) {
            flush(sessionId);
            return;
        }

        scheduleFlush(sessionId, state, windowMs);
    }

    function flushAll(): void {
        for (const sessionId of queues.keys()) {
            flush(sessionId);
        }
    }

    function getQueuedMaxSeq(sessionId: string): number {
        const state = queues.get(sessionId);
        if (!state || state.queued.length === 0) return 0;
        let maxSeq = 0;
        for (const message of state.queued) {
            const seq = message.seq;
            if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
            maxSeq = Math.max(maxSeq, Math.trunc(seq));
        }
        return maxSeq;
    }

    return { enqueue, flush, flushAll, getQueuedMaxSeq };
}
