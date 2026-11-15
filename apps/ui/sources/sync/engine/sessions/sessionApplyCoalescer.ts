import type { Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { reconcileSessionSnapshot } from '@/sync/domains/session/sessionLifecycleProjection';
import { socketApplyFrame, type SocketApplyFrameScheduler } from './socketApplyFrame';

export type SessionApplyCoalescerConfig = Readonly<{
    enabled: boolean;
    windowMs: number;
    maxBatchSize: number;
}>;

export type SessionApplyCoalescerSession = Omit<Session, 'presence'> & {
    presence?: 'online' | number;
};

type SessionApplyOptions = Readonly<{
    shouldContinue?: () => boolean;
}>;

type QueuedSession = Readonly<{
    session: SessionApplyCoalescerSession;
    shouldContinue: () => boolean;
}>;

function clampPositiveInt(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.trunc(value));
}

export function createSessionApplyCoalescer(params: Readonly<{
    getConfig: () => SessionApplyCoalescerConfig;
    applyBatch: (sessions: SessionApplyCoalescerSession[]) => void;
    frame?: SocketApplyFrameScheduler;
}>): Readonly<{
    enqueue: (sessions: SessionApplyCoalescerSession[], options?: SessionApplyOptions) => void;
    flushSessionIds: (sessionIds: readonly string[]) => void;
    flushAll: () => void;
    dropSessionIds: (sessionIds: readonly string[]) => void;
    getQueuedSession: (sessionId: string) => SessionApplyCoalescerSession | undefined;
}> {
    const queuedSessions = new Map<string, QueuedSession>();
    const frame = params.frame ?? socketApplyFrame;
    let cancelScheduledFlush: (() => void) | null = null;

    function clearFlushTimer(): void {
        if (!cancelScheduledFlush) return;
        cancelScheduledFlush();
        cancelScheduledFlush = null;
    }

    function scheduleFlush(windowMs: number): void {
        if (cancelScheduledFlush) return;
        cancelScheduledFlush = frame.schedule(() => {
            cancelScheduledFlush = null;
            flushAll();
        }, windowMs);
    }

    function applyImmediate(sessions: SessionApplyCoalescerSession[], maxBatchSize: number, options?: SessionApplyOptions): void {
        if (options?.shouldContinue && !options.shouldContinue()) return;
        for (let i = 0; i < sessions.length; i += maxBatchSize) {
            const batch = sessions.slice(i, i + maxBatchSize);
            syncPerformanceTelemetry.measure(
                'sync.socket.sessions.coalesce.immediate',
                { sessions: batch.length },
                () => params.applyBatch(batch),
            );
        }
    }

    function applyQueuedBatch(batch: QueuedSession[]): void {
        const sessions: SessionApplyCoalescerSession[] = [];
        for (const entry of batch) {
            if (entry.shouldContinue()) {
                sessions.push(entry.session);
            }
        }
        if (sessions.length === 0) return;
        syncPerformanceTelemetry.measure(
            'sync.socket.sessions.coalesce.flush',
            { sessions: sessions.length, remaining: queuedSessions.size },
            () => params.applyBatch(sessions),
        );
    }

    function upsertQueued(sessions: readonly SessionApplyCoalescerSession[], options?: SessionApplyOptions): void {
        const shouldContinue = options?.shouldContinue ?? (() => true);
        for (const session of sessions) {
            const queued = queuedSessions.get(session.id);
            const previous = queued?.shouldContinue() ? queued.session : undefined;
            queuedSessions.set(session.id, {
                session: reconcileSessionSnapshot(previous, session),
                shouldContinue,
            });
        }
    }

    function takeQueuedBatch(maxBatchSize: number): QueuedSession[] {
        const batch: QueuedSession[] = [];
        for (const [sessionId, entry] of queuedSessions) {
            batch.push(entry);
            queuedSessions.delete(sessionId);
            if (batch.length >= maxBatchSize) break;
        }
        return batch;
    }

    function flushAll(): void {
        clearFlushTimer();
        const maxBatchSize = clampPositiveInt(params.getConfig().maxBatchSize);
        while (queuedSessions.size > 0) {
            applyQueuedBatch(takeQueuedBatch(maxBatchSize));
        }
    }

    function flushSessionIds(sessionIds: readonly string[]): void {
        if (sessionIds.length === 0 || queuedSessions.size === 0) return;

        const ids = new Set(sessionIds.filter((sessionId) => sessionId.length > 0));
        if (ids.size === 0) return;

        const maxBatchSize = clampPositiveInt(params.getConfig().maxBatchSize);
        let batch: QueuedSession[] = [];
        for (const [sessionId, entry] of queuedSessions) {
            if (!ids.has(sessionId)) continue;
            batch.push(entry);
            queuedSessions.delete(sessionId);
            if (batch.length >= maxBatchSize) {
                applyQueuedBatch(batch);
                batch = [];
            }
        }
        applyQueuedBatch(batch);

        if (queuedSessions.size === 0) {
            clearFlushTimer();
        }
    }

    function dropSessionIds(sessionIds: readonly string[]): void {
        if (sessionIds.length === 0 || queuedSessions.size === 0) return;

        let dropped = 0;
        for (const sessionId of sessionIds) {
            if (queuedSessions.delete(sessionId)) {
                dropped += 1;
            }
        }
        if (dropped === 0) return;

        syncPerformanceTelemetry.count('sync.socket.sessions.coalesce.dropped', {
            sessions: dropped,
            queued: queuedSessions.size,
        });
        if (queuedSessions.size === 0) {
            clearFlushTimer();
        }
    }

    function enqueue(sessions: SessionApplyCoalescerSession[], options?: SessionApplyOptions): void {
        if (sessions.length === 0) return;

        const config = params.getConfig();
        const maxBatchSize = clampPositiveInt(config.maxBatchSize);
        const windowMs = Math.max(0, Math.trunc(config.windowMs));
        syncPerformanceTelemetry.count('sync.socket.sessions.coalesce.enqueue', {
            sessions: sessions.length,
            windowMs,
            maxBatchSize,
        });

        if (!config.enabled || windowMs <= 0) {
            applyImmediate(sessions, maxBatchSize, options);
            return;
        }

        upsertQueued(sessions, options);
        syncPerformanceTelemetry.count('sync.socket.sessions.coalesce.queued', {
            sessions: sessions.length,
            queued: queuedSessions.size,
            windowMs,
            maxBatchSize,
        });

        if (queuedSessions.size >= maxBatchSize) {
            applyQueuedBatch(takeQueuedBatch(maxBatchSize));
        }

        if (queuedSessions.size > 0) {
            scheduleFlush(windowMs);
        }
    }

    return {
        enqueue,
        flushSessionIds,
        flushAll,
        dropSessionIds,
        getQueuedSession: (sessionId) => {
            const entry = queuedSessions.get(sessionId);
            if (!entry || !entry.shouldContinue()) return undefined;
            return entry.session;
        },
    };
}
