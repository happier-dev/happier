import type { NormalizedMessage } from '@/sync/typesRaw';
import { markStreamingMessagesAppliedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { recordRealtimeFanoutCoalescerActivity } from '@/sync/runtime/performance/realtimeFanoutTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

export type SessionMessageApplyCoalescerConfig = Readonly<{
    enabled: boolean;
    windowMs: number;
    maxBatchSize: number;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

type SessionMessageApplyOptions = Readonly<{
    deferLeadingBatch?: boolean;
    shouldContinue?: () => boolean;
}>;

type QueuedMessage = Readonly<{
    message: NormalizedMessage;
    deferredLeadingBatch: boolean;
    shouldContinue: () => boolean;
}>;

type SessionQueueState = {
    queued: QueuedMessage[];
    timer: TimerHandle | null;
};

type RealtimeFanoutCoalescerActivityKind = 'enqueue' | 'immediate' | 'flush' | 'drop';

function recordCoalescerFanoutActivity(
    kind: RealtimeFanoutCoalescerActivityKind,
    sessionId: string,
    messages: number,
    queued: number,
): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    recordRealtimeFanoutCoalescerActivity({
        kind,
        sessionId,
        messages,
        queued,
    });
}

export function createSessionMessageApplyCoalescer(params: Readonly<{
    getConfig: () => SessionMessageApplyCoalescerConfig;
    applyBatch: (sessionId: string, messages: NormalizedMessage[]) => void;
    onBatchApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
}>): Readonly<{
    enqueue: (sessionId: string, messages: NormalizedMessage[], options?: SessionMessageApplyOptions) => void;
    dropQueuedMessageIds: (sessionId: string, messageIds: readonly string[]) => void;
    dropSessionIds: (sessionIds: readonly string[]) => void;
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

    function createQueuedMessages(messages: readonly NormalizedMessage[], options?: SessionMessageApplyOptions): QueuedMessage[] {
        const shouldContinue = options?.shouldContinue ?? (() => true);
        const deferredLeadingBatch = options?.deferLeadingBatch === true;
        return messages.map((message) => ({ message, deferredLeadingBatch, shouldContinue }));
    }

    function takeCurrentMessages(entries: readonly QueuedMessage[]): NormalizedMessage[] {
        const messages: NormalizedMessage[] = [];
        for (const entry of entries) {
            if (entry.shouldContinue()) {
                messages.push(entry.message);
            }
        }
        return messages;
    }

    function clearFlushTimer(state: SessionQueueState): void {
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
    }

    function applyImmediate(
        sessionId: string,
        messages: NormalizedMessage[],
        maxBatchSize: number,
        options?: SessionMessageApplyOptions,
    ): void {
        if (messages.length === 0) return;
        if (options?.shouldContinue && !options.shouldContinue()) return;
        if (maxBatchSize <= 0) {
            recordCoalescerFanoutActivity('immediate', sessionId, messages.length, 0);
            syncPerformanceTelemetry.measure(
                'sync.socket.messages.coalesce.immediate',
                { messages: messages.length },
                () => {
                    params.applyBatch(sessionId, messages);
                    params.onBatchApplied?.(sessionId, messages);
                    markStreamingMessagesAppliedForSessionUiTelemetry({
                        sessionId,
                        messages,
                        source: 'socketMessage',
                    });
                },
            );
            return;
        }

        for (let i = 0; i < messages.length; i += maxBatchSize) {
            const batch = messages.slice(i, i + maxBatchSize);
            recordCoalescerFanoutActivity('immediate', sessionId, batch.length, 0);
            syncPerformanceTelemetry.measure(
                'sync.socket.messages.coalesce.immediate',
                { messages: batch.length },
                () => {
                    params.applyBatch(sessionId, batch);
                    params.onBatchApplied?.(sessionId, batch);
                    markStreamingMessagesAppliedForSessionUiTelemetry({
                        sessionId,
                        messages: batch,
                        source: 'socketMessage',
                    });
                },
            );
        }
    }

    function scheduleFlush(sessionId: string, state: SessionQueueState, windowMs: number): void {
        if (state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            flush(sessionId);
        }, windowMs);
    }

    function hasVisibleBlockingQueuedWork(state: SessionQueueState): boolean {
        return state.queued.some((entry) => entry.deferredLeadingBatch || !entry.shouldContinue());
    }

    function flushQueuedSession(sessionId: string): void {
        while (true) {
            const state = queues.get(sessionId);
            if (!state || state.queued.length === 0) return;
            const queuedBefore = state.queued.length;
            flush(sessionId);
            const nextState = queues.get(sessionId);
            if (!nextState || nextState.queued.length >= queuedBefore) return;
        }
    }

    function flush(sessionId: string): void {
        const config = params.getConfig();
        const state = queues.get(sessionId);
        if (!state) return;
        if (state.queued.length === 0) {
            clearFlushTimer(state);
            queues.delete(sessionId);
            return;
        }

        clearFlushTimer(state);

        const maxBatchSize = Math.max(1, Math.trunc(config.maxBatchSize));
        const batch = state.queued.splice(0, maxBatchSize);
        const currentMessages = takeCurrentMessages(batch);
        recordCoalescerFanoutActivity('flush', sessionId, currentMessages.length, state.queued.length);
        syncPerformanceTelemetry.measure(
            'sync.socket.messages.coalesce.flush',
            { messages: batch.length, remaining: state.queued.length },
            () => {
                if (currentMessages.length === 0) return;
                params.applyBatch(sessionId, currentMessages);
                params.onBatchApplied?.(sessionId, currentMessages);
                markStreamingMessagesAppliedForSessionUiTelemetry({
                    sessionId,
                    messages: currentMessages,
                    source: 'socketMessage',
                });
            },
        );

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
        const remainingMessages = takeCurrentMessages(state.queued.splice(0, state.queued.length));
        applyImmediate(sessionId, remainingMessages, maxBatchSize);
        queues.delete(sessionId);
    }

    function enqueue(sessionId: string, messages: NormalizedMessage[], options?: SessionMessageApplyOptions): void {
        if (messages.length === 0) return;

        const config = params.getConfig();
        const maxBatchSize = Math.max(1, Math.trunc(config.maxBatchSize));
        const windowMs = Math.max(0, Math.trunc(config.windowMs));
        syncPerformanceTelemetry.count('sync.socket.messages.coalesce.enqueue', {
            messages: messages.length,
            windowMs,
            maxBatchSize,
        });

        if (!config.enabled || windowMs <= 0) {
            applyImmediate(sessionId, messages, maxBatchSize, options);
            return;
        }

        const existingState = queues.get(sessionId);
        if (options?.deferLeadingBatch !== true && existingState && hasVisibleBlockingQueuedWork(existingState)) {
            flushQueuedSession(sessionId);
        }

        const state = getOrCreateQueue(sessionId);
        if (state.timer === null && state.queued.length === 0) {
            if (options?.deferLeadingBatch === true) {
                state.queued.push(...createQueuedMessages(messages, options));
                recordCoalescerFanoutActivity('enqueue', sessionId, messages.length, state.queued.length);
                syncPerformanceTelemetry.count('sync.socket.messages.coalesce.queued', {
                    messages: messages.length,
                    queued: state.queued.length,
                    leadingDeferred: 1,
                    windowMs,
                    maxBatchSize,
                });
                if (state.queued.length >= maxBatchSize) {
                    flush(sessionId);
                    return;
                }
                scheduleFlush(sessionId, state, windowMs);
                return;
            }

            const leadingBatch = messages.slice(0, maxBatchSize);
            const trailingMessages = messages.slice(maxBatchSize);
            applyImmediate(sessionId, leadingBatch, maxBatchSize, options);
            state.queued.push(...createQueuedMessages(trailingMessages, options));
            if (trailingMessages.length > 0) {
                recordCoalescerFanoutActivity('enqueue', sessionId, trailingMessages.length, state.queued.length);
            }
            scheduleFlush(sessionId, state, windowMs);
            return;
        }

        state.queued.push(...createQueuedMessages(messages, options));
        recordCoalescerFanoutActivity('enqueue', sessionId, messages.length, state.queued.length);
        syncPerformanceTelemetry.count('sync.socket.messages.coalesce.queued', {
            messages: messages.length,
            queued: state.queued.length,
            windowMs,
            maxBatchSize,
        });

        if (state.queued.length >= maxBatchSize) {
            flush(sessionId);
            return;
        }

        scheduleFlush(sessionId, state, windowMs);
    }

    function dropQueuedMessageIds(sessionId: string, messageIds: readonly string[]): void {
        if (messageIds.length === 0) return;

        const state = queues.get(sessionId);
        if (!state || state.queued.length === 0) return;

        const queuedCountBefore = state.queued.length;
        const messageIdSet = new Set(messageIds.filter((messageId) => messageId.length > 0));
        if (messageIdSet.size === 0) return;

        state.queued = state.queued.filter((entry) => !messageIdSet.has(entry.message.id));
        if (state.queued.length === queuedCountBefore) return;
        recordCoalescerFanoutActivity('drop', sessionId, queuedCountBefore - state.queued.length, state.queued.length);
        syncPerformanceTelemetry.count('sync.socket.messages.coalesce.dropped', {
            messages: queuedCountBefore - state.queued.length,
            queued: state.queued.length,
        });

        if (state.queued.length === 0) {
            clearFlushTimer(state);
            queues.delete(sessionId);
        }
    }

    function dropSessionIds(sessionIds: readonly string[]): void {
        if (sessionIds.length === 0 || queues.size === 0) return;

        let dropped = 0;
        for (const sessionId of sessionIds) {
            const state = queues.get(sessionId);
            if (!state) continue;
            const sessionDropped = state.queued.length;
            dropped += sessionDropped;
            if (sessionDropped > 0) {
                recordCoalescerFanoutActivity('drop', sessionId, sessionDropped, 0);
            }
            clearFlushTimer(state);
            queues.delete(sessionId);
        }
        if (dropped === 0) return;

        syncPerformanceTelemetry.count('sync.socket.messages.coalesce.dropped', {
            messages: dropped,
            queued: 0,
        });
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
        for (const entry of state.queued) {
            if (!entry.shouldContinue()) continue;
            const seq = entry.message.seq;
            if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
            maxSeq = Math.max(maxSeq, Math.trunc(seq));
        }
        return maxSeq;
    }

    return { enqueue, dropQueuedMessageIds, dropSessionIds, flush, flushAll, getQueuedMaxSeq };
}
