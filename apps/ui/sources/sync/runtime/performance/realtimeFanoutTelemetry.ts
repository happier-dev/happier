import {
    registerSyncPerformanceTelemetryGlobalLifecycleHooks,
    syncPerformanceTelemetry,
    type SyncPerformanceTelemetry,
} from '@/sync/runtime/syncPerformanceTelemetry';

type RealtimeSocketMessageRoute = 'projectionOnly' | 'markTranscriptStale' | 'fullTranscriptApply' | 'legacyFallback' | string;

type RealtimeFanoutWindow = {
    routeDecisions: number;
    distinctSessionIds: Set<string>;
    newMessages: number;
    messageUpdates: number;
    projectionOnly: number;
    transcriptStale: number;
    fullTranscriptApply: number;
    legacyFallback: number;
    visibleSessionMessages: number;
    backgroundSessionMessages: number;
    fullContentConsumerMessages: number;
    messagesLoaded: number;
    seqKnown: number;
    coalescerEnqueues: number;
    coalescerMessagesEnqueued: number;
    coalescerImmediateBatches: number;
    coalescerMessagesImmediate: number;
    coalescerFlushes: number;
    coalescerMessagesFlushed: number;
    coalescerDrops: number;
    coalescerMessagesDropped: number;
    maxCoalescerQueueDepth: number;
};

type RealtimeFanoutTelemetryAccumulatorOptions = Readonly<{
    telemetry?: SyncPerformanceTelemetry;
    windowMs?: number;
    now?: () => number;
}>;

type RecordSocketMessageRouteParams = Readonly<{
    sessionId: string;
    updateType: 'new-message' | 'message-updated';
    route: RealtimeSocketMessageRoute;
    visible: boolean;
    fullContentConsumerActive: boolean;
    messagesLoaded: boolean;
    messageSeq: number | null;
}>;

type RecordCoalescerActivityParams = Readonly<{
    kind: 'enqueue' | 'immediate' | 'flush' | 'drop';
    sessionId: string;
    messages: number;
    queued: number;
}>;

function defaultNow(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

function createEmptyWindow(): RealtimeFanoutWindow {
    return {
        routeDecisions: 0,
        distinctSessionIds: new Set(),
        newMessages: 0,
        messageUpdates: 0,
        projectionOnly: 0,
        transcriptStale: 0,
        fullTranscriptApply: 0,
        legacyFallback: 0,
        visibleSessionMessages: 0,
        backgroundSessionMessages: 0,
        fullContentConsumerMessages: 0,
        messagesLoaded: 0,
        seqKnown: 0,
        coalescerEnqueues: 0,
        coalescerMessagesEnqueued: 0,
        coalescerImmediateBatches: 0,
        coalescerMessagesImmediate: 0,
        coalescerFlushes: 0,
        coalescerMessagesFlushed: 0,
        coalescerDrops: 0,
        coalescerMessagesDropped: 0,
        maxCoalescerQueueDepth: 0,
    };
}

function hasWindowActivity(window: RealtimeFanoutWindow): boolean {
    return window.routeDecisions > 0
        || window.coalescerEnqueues > 0
        || window.coalescerImmediateBatches > 0
        || window.coalescerFlushes > 0
        || window.coalescerDrops > 0;
}

function incrementRoute(window: RealtimeFanoutWindow, route: RealtimeSocketMessageRoute): void {
    if (route === 'projectionOnly') {
        window.projectionOnly += 1;
        return;
    }
    if (route === 'markTranscriptStale') {
        window.transcriptStale += 1;
        return;
    }
    if (route === 'fullTranscriptApply') {
        window.fullTranscriptApply += 1;
        return;
    }
    if (route === 'legacyFallback') {
        window.legacyFallback += 1;
    }
}

function sanitizePositiveInteger(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function emitWindow(
    telemetry: SyncPerformanceTelemetry,
    window: RealtimeFanoutWindow,
    windowMs: number,
    configuredWindowMs: number,
): void {
    if (!hasWindowActivity(window)) return;
    const effectiveWindowMs = Math.max(1, Math.trunc(windowMs));
    const rateWindowMs = Math.max(effectiveWindowMs, configuredWindowMs);
    const perSecondScale = 1_000 / rateWindowMs;
    const projectionPatches = window.projectionOnly + window.transcriptStale;
    telemetry.count('sync.sessions.realtime.fanout.window', {
        windowMs: effectiveWindowMs,
        routeDecisions: window.routeDecisions,
        socketMessagesPerSecond: window.routeDecisions * perSecondScale,
        distinctSessions: window.distinctSessionIds.size,
        distinctSessionsPerSecond: window.distinctSessionIds.size * perSecondScale,
        newMessages: window.newMessages,
        messageUpdates: window.messageUpdates,
        projectionOnly: window.projectionOnly,
        transcriptStale: window.transcriptStale,
        projectionPatches,
        projectionPatchesPerSecond: projectionPatches * perSecondScale,
        fullTranscriptApply: window.fullTranscriptApply,
        fullTranscriptAppliesPerSecond: window.fullTranscriptApply * perSecondScale,
        legacyFallback: window.legacyFallback,
        visibleSessionMessages: window.visibleSessionMessages,
        backgroundSessionMessages: window.backgroundSessionMessages,
        fullContentConsumerMessages: window.fullContentConsumerMessages,
        messagesLoaded: window.messagesLoaded,
        seqKnown: window.seqKnown,
        coalescerEnqueues: window.coalescerEnqueues,
        coalescerMessagesEnqueued: window.coalescerMessagesEnqueued,
        coalescerImmediateBatches: window.coalescerImmediateBatches,
        coalescerMessagesImmediate: window.coalescerMessagesImmediate,
        coalescerFlushes: window.coalescerFlushes,
        coalescerMessagesFlushed: window.coalescerMessagesFlushed,
        coalescerDrops: window.coalescerDrops,
        coalescerMessagesDropped: window.coalescerMessagesDropped,
        maxCoalescerQueueDepth: window.maxCoalescerQueueDepth,
    });
}

export function createRealtimeFanoutTelemetryAccumulator(options: RealtimeFanoutTelemetryAccumulatorOptions = {}) {
    const telemetry = options.telemetry ?? syncPerformanceTelemetry;
    const now = options.now ?? defaultNow;
    const windowMs = Math.max(1, sanitizePositiveInteger(options.windowMs ?? 1_000));

    let windowStartedAt: number | null = null;
    let window = createEmptyWindow();

    function flushExpiredWindow(nextNow: number): void {
        if (windowStartedAt === null || windowMs <= 0) return;
        if (nextNow - windowStartedAt < windowMs) return;
        emitWindow(telemetry, window, Math.max(1, nextNow - windowStartedAt), windowMs);
        window = createEmptyWindow();
        windowStartedAt = nextNow;
    }

    function ensureWindow(): void {
        const currentNow = now();
        if (windowStartedAt === null) {
            windowStartedAt = currentNow;
            return;
        }
        flushExpiredWindow(currentNow);
    }

    return {
        recordSocketMessageRoute(params: RecordSocketMessageRouteParams): void {
            if (!telemetry.isEnabled()) return;
            ensureWindow();
            window.routeDecisions += 1;
            const sessionId = params.sessionId.trim();
            if (sessionId.length > 0) {
                window.distinctSessionIds.add(sessionId);
            }
            if (params.updateType === 'new-message') {
                window.newMessages += 1;
            } else {
                window.messageUpdates += 1;
            }
            incrementRoute(window, params.route);
            if (params.visible) {
                window.visibleSessionMessages += 1;
            } else {
                window.backgroundSessionMessages += 1;
            }
            if (params.fullContentConsumerActive) {
                window.fullContentConsumerMessages += 1;
            }
            if (params.messagesLoaded) {
                window.messagesLoaded += 1;
            }
            if (params.messageSeq !== null) {
                window.seqKnown += 1;
            }
        },
        recordCoalescerActivity(params: RecordCoalescerActivityParams): void {
            if (!telemetry.isEnabled()) return;
            ensureWindow();
            const messages = sanitizePositiveInteger(params.messages);
            const queued = sanitizePositiveInteger(params.queued);
            const sessionId = params.sessionId.trim();
            if (sessionId.length > 0) {
                window.distinctSessionIds.add(sessionId);
            }
            window.maxCoalescerQueueDepth = Math.max(window.maxCoalescerQueueDepth, queued);
            if (params.kind === 'enqueue') {
                window.coalescerEnqueues += 1;
                window.coalescerMessagesEnqueued += messages;
                return;
            }
            if (params.kind === 'immediate') {
                window.coalescerImmediateBatches += 1;
                window.coalescerMessagesImmediate += messages;
                return;
            }
            if (params.kind === 'flush') {
                window.coalescerFlushes += 1;
                window.coalescerMessagesFlushed += messages;
                return;
            }
            window.coalescerDrops += 1;
            window.coalescerMessagesDropped += messages;
        },
        flush(): void {
            const currentNow = now();
            const elapsedWindowMs = windowStartedAt === null
                ? windowMs
                : currentNow - windowStartedAt;
            emitWindow(telemetry, window, elapsedWindowMs > 0 ? elapsedWindowMs : windowMs, windowMs);
            window = createEmptyWindow();
            windowStartedAt = null;
        },
        reset(): void {
            window = createEmptyWindow();
            windowStartedAt = null;
        },
    };
}

const realtimeFanoutTelemetry = createRealtimeFanoutTelemetryAccumulator({
    telemetry: syncPerformanceTelemetry,
});

registerSyncPerformanceTelemetryGlobalLifecycleHooks({
    beforeCollect: () => realtimeFanoutTelemetry.flush(),
    reset: () => realtimeFanoutTelemetry.reset(),
});

export function recordRealtimeFanoutSocketMessageRoute(params: RecordSocketMessageRouteParams): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    realtimeFanoutTelemetry.recordSocketMessageRoute(params);
}

export function recordRealtimeFanoutCoalescerActivity(params: RecordCoalescerActivityParams): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    realtimeFanoutTelemetry.recordCoalescerActivity(params);
}

export function flushRealtimeFanoutTelemetry(): void {
    realtimeFanoutTelemetry.flush();
}

export function resetRealtimeFanoutTelemetry(): void {
    realtimeFanoutTelemetry.reset();
}
