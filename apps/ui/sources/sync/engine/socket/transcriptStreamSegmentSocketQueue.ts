import type { Session } from '@/sync/domains/state/storageTypes';
import type {
    AnyTranscriptStreamSegmentEphemeralUpdate,
    TranscriptStreamSegmentSessionMessageEncryption,
} from '@/sync/engine/sessions/handleTranscriptStreamSegmentEphemeralUpdate';
import { handleTranscriptStreamSegmentEphemeralUpdate } from '@/sync/engine/sessions/handleTranscriptStreamSegmentEphemeralUpdate';
import type { SessionMessageApplyCoalescerConfig } from '@/sync/engine/sessions/sessionMessageApplyCoalescer';
import type { NormalizedMessage, RawMessageNormalizationSequenceState } from '@/sync/typesRaw';

type TranscriptStreamSegmentHandler = typeof handleTranscriptStreamSegmentEphemeralUpdate;
type TimerHandle = ReturnType<typeof setTimeout>;

type DeferredTranscriptStreamSegmentQueueState = {
    queued: TranscriptStreamSegmentSocketQueueEntry[];
    timer: TimerHandle | null;
};

export type TranscriptStreamSegmentMessageCoalescer = Readonly<{
    enqueue: (
        sessionId: string,
        messages: NormalizedMessage[],
        options?: Readonly<{ shouldContinue?: () => boolean }>,
    ) => void;
    flush: (sessionId: string) => void;
}>;

export type TranscriptStreamSegmentSocketQueueEntry = Readonly<{
    update: AnyTranscriptStreamSegmentEphemeralUpdate;
    sourceServerId?: string | null;
    shouldContinue: () => boolean;
    getSessionEncryption: (sessionId: string) => TranscriptStreamSegmentSessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applyMessages?: (sessionId: string, messages: NormalizedMessage[]) => void;
    rawMessageNormalizationState?: RawMessageNormalizationSequenceState;
}>;

export function createTranscriptStreamSegmentSocketQueueController(params: Readonly<{
    getConfig: () => SessionMessageApplyCoalescerConfig;
    isSessionVisible: (sessionId: string, sourceServerId?: string | null) => boolean;
    messageCoalescer: TranscriptStreamSegmentMessageCoalescer;
    prepareApplyEntry?: (entry: TranscriptStreamSegmentSocketQueueEntry) => void;
    handleTranscriptStreamSegment?: TranscriptStreamSegmentHandler;
    onDeferredRawQueued?: (fields: Readonly<{ queued: number; windowMs: number; maxBatchSize: number }>) => void;
    onDeferredRawDroppedHidden?: (fields: Readonly<{ messages: number }>) => void;
}>): Readonly<{
    handle: (entry: TranscriptStreamSegmentSocketQueueEntry) => Promise<void>;
    flush: (sessionId: string) => Promise<void>;
    drop: (sessionId: string) => void;
}> {
    const handleTranscriptStreamSegment = params.handleTranscriptStreamSegment ?? handleTranscriptStreamSegmentEphemeralUpdate;
    const queues = new Map<string, DeferredTranscriptStreamSegmentQueueState>();

    function getOrCreateQueue(sessionId: string): DeferredTranscriptStreamSegmentQueueState {
        const existing = queues.get(sessionId);
        if (existing) return existing;
        const created: DeferredTranscriptStreamSegmentQueueState = { queued: [], timer: null };
        queues.set(sessionId, created);
        return created;
    }

    function clearTimer(state: DeferredTranscriptStreamSegmentQueueState): void {
        if (!state.timer) return;
        clearTimeout(state.timer);
        state.timer = null;
    }

    function hasLiveQueuedEntry(sessionId: string, state: DeferredTranscriptStreamSegmentQueueState): boolean {
        return state.queued.some((entry) => params.isSessionVisible(sessionId, entry.sourceServerId));
    }

    async function applyEntry(entry: TranscriptStreamSegmentSocketQueueEntry): Promise<void> {
        if (!entry.shouldContinue()) return;
        if (!params.isSessionVisible(entry.update.sessionId, entry.sourceServerId)) {
            params.onDeferredRawDroppedHidden?.({ messages: 1 });
            return;
        }
        params.prepareApplyEntry?.(entry);
        await handleTranscriptStreamSegment({
            update: entry.update,
            getSessionEncryption: entry.getSessionEncryption,
            getSession: entry.getSession,
            applyMessages: (sessionId, messages) => params.messageCoalescer.enqueue(sessionId, messages, {
                shouldContinue: entry.shouldContinue,
            }),
            rawMessageNormalizationState: entry.rawMessageNormalizationState,
            isSessionActivelyViewed: (sessionId) => params.isSessionVisible(sessionId, entry.sourceServerId),
            skipWhenHidden: true,
        });
    }

    async function flush(sessionId: string): Promise<void> {
        const state = queues.get(sessionId);
        if (!state) return;
        clearTimer(state);
        const entries = state.queued.splice(0, state.queued.length);
        queues.delete(sessionId);
        for (const entry of entries) {
            await applyEntry(entry);
            params.messageCoalescer.flush(sessionId);
        }
    }

    function drop(sessionId: string): void {
        const state = queues.get(sessionId);
        if (!state) return;
        clearTimer(state);
        const dropped = state.queued.length;
        queues.delete(sessionId);
        if (dropped > 0) {
            params.onDeferredRawDroppedHidden?.({ messages: dropped });
        }
    }

    function scheduleFlush(sessionId: string, state: DeferredTranscriptStreamSegmentQueueState, windowMs: number): void {
        if (state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            if (!hasLiveQueuedEntry(sessionId, state)) {
                drop(sessionId);
                return;
            }
            void flush(sessionId);
        }, windowMs);
    }

    function enqueue(entry: TranscriptStreamSegmentSocketQueueEntry, config: SessionMessageApplyCoalescerConfig): void {
        const sessionId = entry.update.sessionId;
        const maxBatchSize = Math.max(1, Math.trunc(config.maxBatchSize));
        const windowMs = Math.max(0, Math.trunc(config.windowMs));
        const state = getOrCreateQueue(sessionId);
        const existingIndex = state.queued.findIndex((queuedEntry) =>
            queuedEntry.update.message.localId === entry.update.message.localId
                && (queuedEntry.update.message.sidechainId ?? null) === (entry.update.message.sidechainId ?? null),
        );
        if (existingIndex >= 0) {
            state.queued[existingIndex] = entry;
        } else {
            state.queued.push(entry);
        }
        params.onDeferredRawQueued?.({
            queued: state.queued.length,
            windowMs,
            maxBatchSize,
        });

        if (state.queued.length >= maxBatchSize) {
            if (!hasLiveQueuedEntry(sessionId, state)) {
                drop(sessionId);
                return;
            }
            void flush(sessionId);
            return;
        }

        scheduleFlush(sessionId, state, windowMs);
    }

    async function handle(entry: TranscriptStreamSegmentSocketQueueEntry): Promise<void> {
        const sessionId = entry.update.sessionId;
        const isDelta = entry.update.type === 'transcript-stream-segment-delta';
        const config = params.getConfig();
        const windowMs = Math.max(0, Math.trunc(config.windowMs));
        const hiddenQueueEnabled = config.enabled && windowMs > 0;
        if (!params.isSessionVisible(sessionId, entry.sourceServerId)) {
            // Deltas are never deferred: the hidden queue dedupes by localId keeping the latest
            // entry, which would collapse distinct deltas and corrupt reconstruction. Hidden
            // sessions stay fresh via the ~1Hz full-snapshot checkpoints; assembly resyncs from
            // the next checkpoint when the session becomes visible.
            if (isDelta) {
                params.onDeferredRawDroppedHidden?.({ messages: 1 });
                return;
            }
            if (hiddenQueueEnabled) {
                enqueue(entry, config);
                return;
            }
        }
        if (params.isSessionVisible(sessionId, entry.sourceServerId)) {
            await flush(sessionId);
        }
        await applyEntry(entry);
    }

    return { handle, flush, drop };
}
