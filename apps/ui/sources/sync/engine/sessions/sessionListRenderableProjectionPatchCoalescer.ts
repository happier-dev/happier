import {
    applySessionListRenderablePatch,
    areSessionListRenderablesEqual,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { SessionListRenderablePatch } from '@/sync/store/domains/sessionListRenderableStoreUpdate';

export type SessionListRenderableProjectionPatchCoalescerConfig = Readonly<{
    enabled: boolean;
    windowMs: number;
    maxBatchSize: number;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

type QueueOptions = Readonly<{
    shouldContinue?: () => boolean;
    deferLeadingPatch?: boolean;
    forceImmediate?: boolean;
}>;

type QueuedProjectionPatch<Payload> = Readonly<{
    payload: Payload;
    shouldContinue: () => boolean;
}>;

type QueuedProjectionPatchBatch<Payload> = ReadonlyArray<readonly [string, readonly QueuedProjectionPatch<Payload>[]]>;

function clampPositiveInt(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.trunc(value));
}

function countBatchEntries<Payload>(batch: QueuedProjectionPatchBatch<Payload>): number {
    return batch.reduce((total, [, entries]) => total + entries.length, 0);
}

function countQueuedEntries<Payload>(queuedBySession: ReadonlyMap<string, readonly QueuedProjectionPatch<Payload>[]>): number {
    let count = 0;
    for (const entries of queuedBySession.values()) count += entries.length;
    return count;
}

export function createSessionListRenderableProjectionPatchCoalescer<Payload>(params: Readonly<{
    getConfig: () => SessionListRenderableProjectionPatchCoalescerConfig;
    readRenderable: (sessionId: string) => SessionListRenderableSession | undefined;
    buildPatch: (input: Readonly<{
        renderable: SessionListRenderableSession;
        payload: Payload;
    }>) => Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
    applyPatches: (patches: SessionListRenderablePatch[]) => void;
}>): Readonly<{
    enqueue: (sessionId: string, payload: Payload, options?: QueueOptions) => void;
    flushAll: () => void;
    dropSessionIds: (sessionIds: readonly string[]) => void;
    reset: () => void;
}> {
    const queuedBySession = new Map<string, QueuedProjectionPatch<Payload>[]>();
    const leadingWindowExpiresAtBySession = new Map<string, number>();
    let timer: TimerHandle | null = null;

    function clearFlushTimer(): void {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
    }

    function scheduleFlush(windowMs: number): void {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            flushAll();
        }, windowMs);
    }

    function applyBatch(batch: QueuedProjectionPatchBatch<Payload>, eventName: string): void {
        if (batch.length === 0) return;

        const patches: SessionListRenderablePatch[] = [];
        let missingRenderableSessions = 0;
        let skippedEntries = 0;
        let noPatchSessions = 0;
        let noopSessions = 0;
        for (const [sessionId, entries] of batch) {
            const renderable = params.readRenderable(sessionId);
            if (!renderable) {
                missingRenderableSessions += 1;
                continue;
            }

            let simulatedRenderable = renderable;
            let hasPatch = false;
            for (const entry of entries) {
                if (!entry.shouldContinue()) {
                    skippedEntries += 1;
                    continue;
                }
                const patch = params.buildPatch({
                    renderable: simulatedRenderable,
                    payload: entry.payload,
                });
                hasPatch = true;
                simulatedRenderable = applySessionListRenderablePatch(simulatedRenderable, patch);
            }

            if (hasPatch && !areSessionListRenderablesEqual(renderable, simulatedRenderable)) {
                const { id: _id, ...patch } = simulatedRenderable;
                patches.push({ sessionId, patch });
                continue;
            }
            if (hasPatch) {
                noopSessions += 1;
            } else {
                noPatchSessions += 1;
            }
        }

        const suppressedSessions = missingRenderableSessions + noPatchSessions + noopSessions;
        if (suppressedSessions > 0 || skippedEntries > 0) {
            syncPerformanceTelemetry.countLazy('sync.socket.sessions.projectionPatch.coalesce.suppressed', () => ({
                sessions: batch.length,
                entries: countBatchEntries(batch),
                appliedSessions: patches.length,
                suppressedSessions,
                missingRenderableSessions,
                skippedEntries,
                noPatchSessions,
                noopSessions,
            }));
        }

        if (patches.length === 0) return;
        syncPerformanceTelemetry.measure(
            eventName,
            { sessions: patches.length, entries: countBatchEntries(batch) },
            () => params.applyPatches(patches),
        );
    }

    function upsertQueued(sessionId: string, entry: QueuedProjectionPatch<Payload>): void {
        const existing = queuedBySession.get(sessionId);
        if (existing) {
            existing.push(entry);
            return;
        }
        queuedBySession.set(sessionId, [entry]);
    }

    function takeQueuedBatch(maxBatchSize: number): Array<readonly [string, readonly QueuedProjectionPatch<Payload>[]]> {
        const batch: Array<readonly [string, readonly QueuedProjectionPatch<Payload>[]]> = [];
        for (const [sessionId, entries] of queuedBySession) {
            batch.push([sessionId, entries]);
            queuedBySession.delete(sessionId);
            leadingWindowExpiresAtBySession.delete(sessionId);
            if (batch.length >= maxBatchSize) break;
        }
        return batch;
    }

    function takeQueuedSessionBatch(sessionId: string): Array<readonly [string, readonly QueuedProjectionPatch<Payload>[]]> {
        const entries = queuedBySession.get(sessionId);
        if (!entries) return [];
        queuedBySession.delete(sessionId);
        leadingWindowExpiresAtBySession.delete(sessionId);
        return [[sessionId, entries]];
    }

    function flushQueuedSession(sessionId: string): void {
        const batch = takeQueuedSessionBatch(sessionId);
        if (batch.length === 0) return;
        applyBatch(batch, 'sync.socket.sessions.projectionPatch.coalesce.flush');
        if (queuedBySession.size === 0) {
            clearFlushTimer();
        }
    }

    function flushAll(): void {
        clearFlushTimer();
        leadingWindowExpiresAtBySession.clear();
        const maxBatchSize = clampPositiveInt(params.getConfig().maxBatchSize);
        while (queuedBySession.size > 0) {
            applyBatch(takeQueuedBatch(maxBatchSize), 'sync.socket.sessions.projectionPatch.coalesce.flush');
        }
    }

    function dropSessionIds(sessionIds: readonly string[]): void {
        if (sessionIds.length === 0) return;

        let dropped = 0;
        for (const sessionId of sessionIds) {
            leadingWindowExpiresAtBySession.delete(sessionId);
            const entries = queuedBySession.get(sessionId);
            if (!entries) continue;
            dropped += entries.length;
            queuedBySession.delete(sessionId);
        }

        if (queuedBySession.size === 0) {
            clearFlushTimer();
        }
        if (dropped === 0) return;

        syncPerformanceTelemetry.count('sync.socket.sessions.projectionPatch.coalesce.dropped', {
            entries: dropped,
            queuedSessions: queuedBySession.size,
        });
    }

    function reset(): void {
        clearFlushTimer();
        queuedBySession.clear();
        leadingWindowExpiresAtBySession.clear();
    }

    function enqueue(sessionId: string, payload: Payload, options?: QueueOptions): void {
        if (sessionId.length === 0) return;

        const config = params.getConfig();
        const maxBatchSize = clampPositiveInt(config.maxBatchSize);
        const windowMs = Math.max(0, Math.trunc(config.windowMs));
        const entry: QueuedProjectionPatch<Payload> = {
            payload,
            shouldContinue: options?.shouldContinue ?? (() => true),
        };
        syncPerformanceTelemetry.count('sync.socket.sessions.projectionPatch.coalesce.enqueue', {
            sessions: 1,
            entries: 1,
            windowMs,
            maxBatchSize,
            deferLeading: options?.deferLeadingPatch === true ? 1 : 0,
            forceImmediate: options?.forceImmediate === true ? 1 : 0,
        });

        if (!config.enabled || windowMs <= 0) {
            applyBatch([[sessionId, [entry]]], 'sync.socket.sessions.projectionPatch.coalesce.immediate');
            return;
        }

        const nowMs = Date.now();
        if (options?.forceImmediate === true) {
            flushQueuedSession(sessionId);
            leadingWindowExpiresAtBySession.set(sessionId, nowMs + windowMs);
            applyBatch([[sessionId, [entry]]], 'sync.socket.sessions.projectionPatch.coalesce.immediate');
            return;
        }

        const leadingWindowExpiresAt = leadingWindowExpiresAtBySession.get(sessionId) ?? 0;
        const isInsideLeadingWindow = leadingWindowExpiresAt > nowMs;
        if (!isInsideLeadingWindow) {
            leadingWindowExpiresAtBySession.set(sessionId, nowMs + windowMs);
            if (options?.deferLeadingPatch === true) {
                upsertQueued(sessionId, entry);
                syncPerformanceTelemetry.countLazy('sync.socket.sessions.projectionPatch.coalesce.queued', () => ({
                    sessions: queuedBySession.size,
                    entries: countQueuedEntries(queuedBySession),
                    windowMs,
                    maxBatchSize,
                }));
                scheduleFlush(windowMs);
                return;
            }
            applyBatch([[sessionId, [entry]]], 'sync.socket.sessions.projectionPatch.coalesce.immediate');
            return;
        }

        upsertQueued(sessionId, entry);
        syncPerformanceTelemetry.countLazy('sync.socket.sessions.projectionPatch.coalesce.queued', () => ({
            sessions: queuedBySession.size,
            entries: countQueuedEntries(queuedBySession),
            windowMs,
            maxBatchSize,
        }));

        if (queuedBySession.size >= maxBatchSize) {
            applyBatch(takeQueuedBatch(maxBatchSize), 'sync.socket.sessions.projectionPatch.coalesce.flush');
        }

        if (queuedBySession.size > 0) {
            scheduleFlush(windowMs);
        }
    }

    return {
        enqueue,
        flushAll,
        dropSessionIds,
        reset,
    };
}
