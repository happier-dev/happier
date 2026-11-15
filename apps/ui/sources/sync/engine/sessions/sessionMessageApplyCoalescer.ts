import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { markStreamingMessagesAppliedForSessionUiTelemetry } from '@/sync/runtime/performance/sessionUiTelemetry';
import { recordRealtimeFanoutCoalescerActivity } from '@/sync/runtime/performance/realtimeFanoutTelemetry';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { socketApplyFrame, type SocketApplyFrameScheduler } from './socketApplyFrame';

export type SessionMessageApplyCoalescerConfig = Readonly<{
    enabled: boolean;
    windowMs: number;
    maxBatchSize: number;
}>;

export type SessionMessageApplyCallbacks = Readonly<{
    applyBatch: (sessionId: string, messages: NormalizedMessage[]) => void;
    onBatchApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
    /** Only committed rows carry this hook; stream checkpoints must not advance durable currentness. */
    onDurableBatchApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
}>;

export type SessionMessageApplyOptions = Readonly<{
    shouldContinue?: () => boolean;
    callbacks?: SessionMessageApplyCallbacks;
}>;

type QueuedMessage = Readonly<{
    message: NormalizedMessage;
    shouldContinue: () => boolean;
    callbacks: SessionMessageApplyCallbacks;
}>;

type SessionQueueState = {
    queued: QueuedMessage[];
    cancelScheduledFlush: (() => void) | null;
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
    frame?: SocketApplyFrameScheduler;
}>): Readonly<{
    enqueue: (sessionId: string, messages: NormalizedMessage[], options?: SessionMessageApplyOptions) => void;
    dropQueuedMessageIds: (sessionId: string, messageIds: readonly string[]) => void;
    dropSessionIds: (sessionIds: readonly string[]) => void;
    flush: (sessionId: string) => void;
    flushAll: () => void;
    getQueuedMaxSeq: (sessionId: string) => number;
}> {
    const queues = new Map<string, SessionQueueState>();
    const frame = params.frame ?? socketApplyFrame;

    function getOrCreateQueue(sessionId: string): SessionQueueState {
        const existing = queues.get(sessionId);
        if (existing) return existing;
        const created: SessionQueueState = { queued: [], cancelScheduledFlush: null };
        queues.set(sessionId, created);
        return created;
    }

    function createQueuedMessages(messages: readonly NormalizedMessage[], options?: SessionMessageApplyOptions): QueuedMessage[] {
        const shouldContinue = options?.shouldContinue ?? (() => true);
        const callbacks = options?.callbacks ?? params;
        return messages.map((message) => ({ message, shouldContinue, callbacks }));
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

    function applyOriginatingEntries(sessionId: string, entries: readonly QueuedMessage[]): void {
        const current = entries.filter(entry => entry.shouldContinue());
        const first = current[0];
        if (!first) return;
        const messages = current.map(entry => entry.message);
        // Surviving entries share this session's one current Home carrier. Preserve one store
        // publication while retaining the originating Home authority, not the latest socket event.
        first.callbacks.applyBatch(sessionId, messages);
        first.callbacks.onBatchApplied?.(sessionId, messages);
        const durable = current.filter(entry => entry.callbacks.onDurableBatchApplied && entry.shouldContinue());
        durable[0]?.callbacks.onDurableBatchApplied?.(sessionId, durable.map(entry => entry.message));
        markStreamingMessagesAppliedForSessionUiTelemetry({ sessionId, messages, source: 'socketMessage' });
    }

    function clearFlushTimer(state: SessionQueueState): void {
        if (state.cancelScheduledFlush) {
            state.cancelScheduledFlush();
            state.cancelScheduledFlush = null;
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
                    applyOriginatingEntries(sessionId, createQueuedMessages(messages, options));
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
                    applyOriginatingEntries(sessionId, createQueuedMessages(batch, options));
                },
            );
        }
    }

    function scheduleFlush(sessionId: string, state: SessionQueueState, windowMs: number): void {
        if (state.cancelScheduledFlush) return;
        state.cancelScheduledFlush = frame.schedule(() => {
            state.cancelScheduledFlush = null;
            flush(sessionId);
        }, windowMs);
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
                applyOriginatingEntries(sessionId, batch);
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
        const remaining = state.queued.splice(0, state.queued.length);
        for (let index = 0; index < remaining.length; index += maxBatchSize) {
            applyOriginatingEntries(sessionId, remaining.slice(index, index + maxBatchSize));
        }
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

        const state = getOrCreateQueue(sessionId);
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
