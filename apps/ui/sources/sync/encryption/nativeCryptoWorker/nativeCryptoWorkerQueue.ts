import type { SyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import {
    recordNativeCryptoWorkerAppStateActive,
    recordNativeCryptoWorkerAppStateQuiescent,
    recordNativeCryptoWorkerQueueBackpressure,
    recordNativeCryptoWorkerQueueDepth,
    recordNativeCryptoWorkerQueueWait,
} from './nativeCryptoWorkerTelemetry';
import type { CryptoWorkerScope, NativeCryptoWorkerOperation } from './types';

type QueueEntry<T, R> = {
    item: T;
    signal?: AbortSignal;
    enqueuedAtMs: number;
    resolve: (value: R) => void;
    reject: (reason: unknown) => void;
};

export type NativeCryptoWorkerBatchDispatchKind = 'regular' | 'probe';

export type NativeCryptoWorkerBatchDispatchContext = Readonly<{
    signal?: AbortSignal;
}>;

export type NativeCryptoWorkerBatchQueueEnqueueOptions = Readonly<{
    signal?: AbortSignal;
}>;

export type NativeCryptoWorkerBatchQueueOptions<T, R> = Readonly<{
    maxBatchSize: number;
    maxPendingItems?: number;
    operation?: NativeCryptoWorkerOperation;
    dispatchKind?: NativeCryptoWorkerBatchDispatchKind;
    telemetry?: SyncPerformanceTelemetry;
    telemetryEnabled?: boolean;
    now?: () => number;
    onIdle?: () => void;
    dispatch: (items: readonly T[], context: NativeCryptoWorkerBatchDispatchContext) => Promise<readonly R[]>;
}>;

export type NativeCryptoWorkerBatchQueue<T, R> = Readonly<{
    enqueue(item: T, options?: NativeCryptoWorkerBatchQueueEnqueueOptions): Promise<R>;
    getQueueDepth(): number;
}>;

export type RunNativeCryptoWorkerQueuedBatchOptions<T, R> = Readonly<{
    owner: object;
    operation: NativeCryptoWorkerOperation;
    scope: CryptoWorkerScope;
    maxBatchSize: number;
    items: readonly T[];
    telemetry?: SyncPerformanceTelemetry;
    telemetryEnabled?: boolean;
    signal?: AbortSignal;
    dispatchKind?: NativeCryptoWorkerBatchDispatchKind;
    dispatch: (items: readonly T[], context: NativeCryptoWorkerBatchDispatchContext) => Promise<readonly R[]>;
}>;

let queuesByOwner = new WeakMap<object, Map<string, NativeCryptoWorkerBatchQueue<unknown, unknown>>>();

export type NativeCryptoWorkerQueueLifecycleTelemetryOptions = Readonly<{
    telemetry?: SyncPerformanceTelemetry;
    telemetryEnabled?: boolean;
    now?: () => number;
}>;

export type NativeCryptoWorkerQueueActiveOptions = NativeCryptoWorkerQueueLifecycleTelemetryOptions & Readonly<{
    capabilityStalenessMs?: number;
    revalidateCapabilities?: () => Promise<void>;
}>;

type NativeCryptoWorkerQueueLifecycleState = {
    quiescent: boolean;
    resumeBlocked: boolean;
    quiescentStartedAtMs: number | null;
    queuedDuringQuiesceCount: number;
    staleScopeDropsOnResume: number;
    resumePromise: Promise<void> | null;
};

type NativeCryptoWorkerQueueStats = Readonly<{
    pending: number;
    inFlight: number;
}>;

const lifecycleState: NativeCryptoWorkerQueueLifecycleState = {
    quiescent: false,
    resumeBlocked: false,
    quiescentStartedAtMs: null,
    queuedDuringQuiesceCount: 0,
    staleScopeDropsOnResume: 0,
    resumePromise: null,
};
let nextQueueId = 1;
const queueWakeups = new Set<() => void>();
const queueStats = new Map<number, NativeCryptoWorkerQueueStats>();

export class NativeCryptoWorkerQueueBackpressureError extends Error {
    readonly code = 'native_crypto_worker_queue_backpressure';
    readonly operation: NativeCryptoWorkerOperation | undefined;
    readonly queueDepth: number;
    readonly capacity: number;

    constructor(params: Readonly<{
        operation?: NativeCryptoWorkerOperation;
        queueDepth: number;
        capacity: number;
    }>) {
        super('Native crypto worker queue is full');
        this.name = 'NativeCryptoWorkerQueueBackpressureError';
        this.operation = params.operation;
        this.queueDepth = params.queueDepth;
        this.capacity = params.capacity;
    }
}

export class NativeCryptoWorkerQueueCancelledError extends Error {
    readonly code = 'native_crypto_worker_queue_cancelled';
    readonly operation: NativeCryptoWorkerOperation | undefined;

    constructor(params: Readonly<{
        operation?: NativeCryptoWorkerOperation;
    }> = {}) {
        super('Native crypto worker queue entry was cancelled before dispatch');
        this.name = 'NativeCryptoWorkerQueueCancelledError';
        this.operation = params.operation;
    }
}

function defaultNow(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function shouldRecordLifecycleTelemetry(options: NativeCryptoWorkerQueueLifecycleTelemetryOptions): boolean {
    return options.telemetryEnabled === true && options.telemetry?.isEnabled() === true;
}

function readLifecycleNow(options: NativeCryptoWorkerQueueLifecycleTelemetryOptions): number {
    return (options.now ?? defaultNow)();
}

function normalizeCapabilityStalenessMs(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function getAggregateQueueStats(): NativeCryptoWorkerQueueStats {
    let pending = 0;
    let inFlight = 0;
    for (const stats of queueStats.values()) {
        pending += stats.pending;
        inFlight += stats.inFlight;
    }
    return { pending, inFlight };
}

function updateQueueStats(queueId: number, pending: number, inFlight: number): void {
    if (pending === 0 && inFlight === 0) {
        queueStats.delete(queueId);
        return;
    }
    queueStats.set(queueId, { pending, inFlight });
}

function wakeQueuedWork(): void {
    const wakeups = Array.from(queueWakeups);
    queueWakeups.clear();
    for (const wakeup of wakeups) {
        wakeup();
    }
}

function isRegularDispatchBlocked(dispatchKind: NativeCryptoWorkerBatchDispatchKind): boolean {
    return dispatchKind === 'regular' && (lifecycleState.quiescent || lifecycleState.resumeBlocked);
}

export function markNativeCryptoWorkerQueueQuiescent(
    options: NativeCryptoWorkerQueueLifecycleTelemetryOptions = {},
): void {
    if (lifecycleState.quiescent) return;
    lifecycleState.quiescent = true;
    lifecycleState.resumeBlocked = false;
    lifecycleState.resumePromise = null;
    lifecycleState.quiescentStartedAtMs = readLifecycleNow(options);
    lifecycleState.queuedDuringQuiesceCount = 0;
    lifecycleState.staleScopeDropsOnResume = 0;

    if (shouldRecordLifecycleTelemetry(options)) {
        const stats = getAggregateQueueStats();
        recordNativeCryptoWorkerAppStateQuiescent(options.telemetry!, {
            queueDepth: stats.pending,
            inFlightCount: stats.inFlight,
        });
    }
}

export async function markNativeCryptoWorkerQueueActive(
    options: NativeCryptoWorkerQueueActiveOptions = {},
): Promise<void> {
    if (!lifecycleState.quiescent && !lifecycleState.resumeBlocked) return;
    if (lifecycleState.resumePromise) {
        await lifecycleState.resumePromise;
        return;
    }

    const activeStartedAtMs = readLifecycleNow(options);
    const quiescentStartedAtMs = lifecycleState.quiescentStartedAtMs;
    const elapsedQuiescentMs = quiescentStartedAtMs === null
        ? 0
        : Math.max(0, activeStartedAtMs - quiescentStartedAtMs);
    const capabilityStalenessMs = normalizeCapabilityStalenessMs(options.capabilityStalenessMs);
    const shouldRevalidate = Boolean(options.revalidateCapabilities)
        && capabilityStalenessMs > 0
        && elapsedQuiescentMs >= capabilityStalenessMs;
    const queuedDuringQuiesceCount = lifecycleState.queuedDuringQuiesceCount;
    const staleScopeDropsOnResume = lifecycleState.staleScopeDropsOnResume;

    lifecycleState.quiescent = false;
    lifecycleState.resumeBlocked = shouldRevalidate;

    lifecycleState.resumePromise = (async () => {
        let capabilityRevalidatedMs = 0;
        if (shouldRevalidate) {
            const revalidateStartedAtMs = readLifecycleNow(options);
            try {
                await options.revalidateCapabilities?.();
            } catch {
                // Resume dispatch even if the bounded probe fails; normal routing still handles capability failures.
            } finally {
                capabilityRevalidatedMs = Math.max(0, readLifecycleNow(options) - revalidateStartedAtMs);
            }
        }

        lifecycleState.resumeBlocked = false;
        lifecycleState.quiescentStartedAtMs = null;
        lifecycleState.queuedDuringQuiesceCount = 0;
        lifecycleState.staleScopeDropsOnResume = 0;

        if (shouldRecordLifecycleTelemetry(options)) {
            recordNativeCryptoWorkerAppStateActive(options.telemetry!, {
                queuedDuringQuiesceCount,
                capabilityRevalidatedMs,
                staleScopeDropsOnResume,
            });
        }

        wakeQueuedWork();
    })().finally(() => {
        lifecycleState.resumePromise = null;
    });

    await lifecycleState.resumePromise;
}

export function recordNativeCryptoWorkerStaleScopeDropForResume(): void {
    if (lifecycleState.quiescent || lifecycleState.resumeBlocked) {
        lifecycleState.staleScopeDropsOnResume += 1;
    }
}

export function resetNativeCryptoWorkerQueueLifecycleForTests(): void {
    lifecycleState.quiescent = false;
    lifecycleState.resumeBlocked = false;
    lifecycleState.quiescentStartedAtMs = null;
    lifecycleState.queuedDuringQuiesceCount = 0;
    lifecycleState.staleScopeDropsOnResume = 0;
    lifecycleState.resumePromise = null;
    nextQueueId = 1;
    queuesByOwner = new WeakMap<object, Map<string, NativeCryptoWorkerBatchQueue<unknown, unknown>>>();
    queueWakeups.clear();
    queueStats.clear();
}

export function getNativeCryptoWorkerOwnerQueueCountForTests(owner: object): number {
    return queuesByOwner.get(owner)?.size ?? 0;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

function getSharedSignal<T, R>(batch: readonly QueueEntry<T, R>[]): AbortSignal | undefined {
    const signal = batch[0]?.signal;
    return signal && batch.every((entry) => entry.signal === signal) ? signal : undefined;
}

export function createNativeCryptoWorkerBatchQueue<T, R>(
    options: NativeCryptoWorkerBatchQueueOptions<T, R>,
): NativeCryptoWorkerBatchQueue<T, R> {
    const maxBatchSize = Math.max(1, Math.trunc(options.maxBatchSize));
    const maxPendingItems = Math.max(1, Math.trunc(options.maxPendingItems ?? maxBatchSize));
    const dispatchKind = options.dispatchKind ?? 'regular';
    const pending: Array<QueueEntry<T, R>> = [];
    let draining = false;
    let scheduled = false;
    let inFlightCount = 0;
    const queueId = nextQueueId;
    nextQueueId += 1;

    const now = options.now ?? defaultNow;

    function updateLifecycleStats(): void {
        updateQueueStats(queueId, pending.length, inFlightCount);
    }

    function shouldRecordTelemetry(): boolean {
        return options.telemetryEnabled === true
            && options.operation !== undefined
            && options.telemetry?.isEnabled() === true;
    }

    function pendingCapacity(): number {
        return draining || inFlightCount > 0
            ? maxPendingItems
            : maxBatchSize + maxPendingItems;
    }

    function rejectForBackpressure(reject: (reason: unknown) => void): void {
        const capacity = pendingCapacity();
        if (shouldRecordTelemetry()) {
            recordNativeCryptoWorkerQueueBackpressure(options.telemetry!, {
                operation: options.operation!,
                queueDepth: pending.length,
                inFlightCount,
                capacity,
            });
        }
        reject(new NativeCryptoWorkerQueueBackpressureError({
            operation: options.operation,
            queueDepth: pending.length,
            capacity,
        }));
    }

    function rejectForCancellation(entry: QueueEntry<T, R>): void {
        entry.reject(new NativeCryptoWorkerQueueCancelledError({
            operation: options.operation,
        }));
    }

    async function drain(): Promise<void> {
        if (draining) return;
        draining = true;
        try {
            while (pending.length > 0) {
                if (isRegularDispatchBlocked(dispatchKind)) {
                    queueWakeups.add(schedule);
                    break;
                }
                queueWakeups.delete(schedule);
                const batch = pending.splice(0, maxBatchSize);
                updateLifecycleStats();
                const activeBatch: Array<QueueEntry<T, R>> = [];
                for (const entry of batch) {
                    if (isSignalAborted(entry.signal)) {
                        rejectForCancellation(entry);
                    } else {
                        activeBatch.push(entry);
                    }
                }
                if (activeBatch.length === 0) {
                    inFlightCount = 0;
                    updateLifecycleStats();
                    continue;
                }
                inFlightCount = activeBatch.length;
                updateLifecycleStats();
                if (shouldRecordTelemetry()) {
                    const waitMs = Math.max(0, ...activeBatch.map((entry) => now() - entry.enqueuedAtMs));
                    recordNativeCryptoWorkerQueueWait(options.telemetry!, {
                        operation: options.operation!,
                        items: activeBatch.length,
                        queueDepth: activeBatch.length + pending.length,
                        waitMs,
                    });
                }
                try {
                    const dispatchSignal = getSharedSignal(activeBatch);
                    if (isSignalAborted(dispatchSignal)) {
                        for (const entry of activeBatch) {
                            rejectForCancellation(entry);
                        }
                        continue;
                    }
                    const results = await options.dispatch(
                        activeBatch.map((entry) => entry.item),
                        { signal: dispatchSignal },
                    );
                    if (results.length !== activeBatch.length) {
                        throw new Error('native crypto worker batch returned an unexpected result count');
                    }
                    for (let index = 0; index < activeBatch.length; index += 1) {
                        const entry = activeBatch[index]!;
                        if (isSignalAborted(entry.signal)) {
                            rejectForCancellation(entry);
                        } else {
                            entry.resolve(results[index]!);
                        }
                    }
                } catch (error) {
                    for (const entry of activeBatch) {
                        entry.reject(error);
                    }
                } finally {
                    inFlightCount = 0;
                    updateLifecycleStats();
                }
            }
        } finally {
            draining = false;
            if (pending.length > 0) {
                if (isRegularDispatchBlocked(dispatchKind)) {
                    queueWakeups.add(schedule);
                } else {
                    schedule();
                }
            }
            updateLifecycleStats();
            if (pending.length === 0 && inFlightCount === 0) {
                options.onIdle?.();
            }
        }
    }

    function schedule(): void {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            void drain();
        });
    }

    return {
        enqueue(item: T, enqueueOptions: NativeCryptoWorkerBatchQueueEnqueueOptions = {}): Promise<R> {
            return new Promise<R>((resolve, reject) => {
                if (isSignalAborted(enqueueOptions.signal)) {
                    reject(new NativeCryptoWorkerQueueCancelledError({
                        operation: options.operation,
                    }));
                    return;
                }
                if (pending.length >= pendingCapacity()) {
                    rejectForBackpressure(reject);
                    return;
                }
                pending.push({ item, signal: enqueueOptions.signal, enqueuedAtMs: now(), resolve, reject });
                if (dispatchKind === 'regular' && lifecycleState.quiescent) {
                    lifecycleState.queuedDuringQuiesceCount += 1;
                }
                updateLifecycleStats();
                if (shouldRecordTelemetry()) {
                    recordNativeCryptoWorkerQueueDepth(options.telemetry!, {
                        operation: options.operation!,
                        queueDepth: pending.length,
                        inFlightCount,
                    });
                }
                schedule();
            });
        },
        getQueueDepth(): number {
            return pending.length;
        },
    };
}

function queueKeyFor(options: RunNativeCryptoWorkerQueuedBatchOptions<unknown, unknown>): string {
    return [
        options.operation,
        options.scope.accountId,
        options.scope.serverId ?? '',
        String(options.scope.generation),
        String(Math.max(1, Math.trunc(options.maxBatchSize))),
        options.telemetryEnabled === true ? 'telemetry' : 'silent',
    ].join('\u0000');
}

export async function runNativeCryptoWorkerQueuedBatch<T, R>(
    options: RunNativeCryptoWorkerQueuedBatchOptions<T, R>,
): Promise<readonly R[]> {
    if (options.items.length === 0) {
        return [];
    }

    let queues = queuesByOwner.get(options.owner);
    if (!queues) {
        queues = new Map<string, NativeCryptoWorkerBatchQueue<unknown, unknown>>();
        queuesByOwner.set(options.owner, queues);
    }

    const key = queueKeyFor(options as RunNativeCryptoWorkerQueuedBatchOptions<unknown, unknown>);
    let queue = queues.get(key) as NativeCryptoWorkerBatchQueue<T, R> | undefined;
    if (!queue) {
        let createdQueue: NativeCryptoWorkerBatchQueue<T, R> | undefined;
        createdQueue = createNativeCryptoWorkerBatchQueue<T, R>({
            maxBatchSize: options.maxBatchSize,
            operation: options.operation,
            dispatchKind: options.dispatchKind,
            telemetry: options.telemetry,
            telemetryEnabled: options.telemetryEnabled,
            onIdle: () => {
                const currentQueues = queuesByOwner.get(options.owner);
                if (!currentQueues || createdQueue === undefined) return;
                if (currentQueues.get(key) !== createdQueue) return;
                currentQueues.delete(key);
                if (currentQueues.size === 0) {
                    queuesByOwner.delete(options.owner);
                }
            },
            dispatch: options.dispatch,
        });
        queue = createdQueue;
        queues.set(key, queue as NativeCryptoWorkerBatchQueue<unknown, unknown>);
    }

    const results: R[] = [];
    const enqueueWindowSize = Math.max(1, Math.trunc(options.maxBatchSize)) * 2;
    for (let index = 0; index < options.items.length; index += enqueueWindowSize) {
        const window = options.items.slice(index, index + enqueueWindowSize);
        results.push(...await Promise.all(window.map((item) => queue.enqueue(item, { signal: options.signal }))));
    }
    return results;
}
