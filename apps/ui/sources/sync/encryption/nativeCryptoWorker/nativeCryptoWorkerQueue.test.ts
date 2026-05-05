import { describe, expect, it } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { createSyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import * as nativeCryptoWorkerQueueModule from './nativeCryptoWorkerQueue';
import {
    createNativeCryptoWorkerBatchQueue,
    runNativeCryptoWorkerQueuedBatch,
} from './nativeCryptoWorkerQueue';

type NativeCryptoWorkerQueueLifecycleExports = Readonly<{
    getNativeCryptoWorkerOwnerQueueCountForTests: (owner: object) => number;
    markNativeCryptoWorkerQueueQuiescent: (options?: Readonly<{ now?: () => number }>) => void;
    markNativeCryptoWorkerQueueActive: (options?: Readonly<{
        now?: () => number;
        capabilityStalenessMs?: number;
        revalidateCapabilities?: () => Promise<void>;
    }>) => Promise<void>;
    resetNativeCryptoWorkerQueueLifecycleForTests: () => void;
}>;

async function getPromiseSettlement<T>(promise: Promise<T>): Promise<PromiseSettledResult<T> | null> {
    let settlement: PromiseSettledResult<T> | null = null;
    promise.then(
        (value) => {
            settlement = { status: 'fulfilled', value };
        },
        (reason: unknown) => {
            settlement = { status: 'rejected', reason };
        },
    );
    await Promise.resolve();
    return settlement;
}

function getQueueLifecycleExports(): NativeCryptoWorkerQueueLifecycleExports {
    const candidate = nativeCryptoWorkerQueueModule as Partial<NativeCryptoWorkerQueueLifecycleExports>;
    expect(candidate.getNativeCryptoWorkerOwnerQueueCountForTests).toBeTypeOf('function');
    expect(candidate.markNativeCryptoWorkerQueueQuiescent).toBeTypeOf('function');
    expect(candidate.markNativeCryptoWorkerQueueActive).toBeTypeOf('function');
    expect(candidate.resetNativeCryptoWorkerQueueLifecycleForTests).toBeTypeOf('function');
    return candidate as NativeCryptoWorkerQueueLifecycleExports;
}

describe('createNativeCryptoWorkerBatchQueue', () => {
    it('queues regular work without native dispatch while AppState is quiescent', async () => {
        const lifecycle = getQueueLifecycleExports();
        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
        lifecycle.markNativeCryptoWorkerQueueQuiescent();

        const dispatches: number[][] = [];
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 2,
            dispatch: async (items) => {
                dispatches.push([...items]);
                return items.map((item) => `r${item}`);
            },
        });

        const result = queue.enqueue(1);
        await Promise.resolve();
        expect(dispatches).toEqual([]);
        expect(await getPromiseSettlement(result)).toBeNull();

        await lifecycle.markNativeCryptoWorkerQueueActive();
        await expect(result).resolves.toBe('r1');
        expect(dispatches).toEqual([[1]]);

        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('allows explicitly marked probe work to dispatch while AppState is quiescent', async () => {
        const lifecycle = getQueueLifecycleExports();
        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
        lifecycle.markNativeCryptoWorkerQueueQuiescent();

        const dispatches: number[][] = [];
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 2,
            dispatchKind: 'probe',
            dispatch: async (items) => {
                dispatches.push([...items]);
                return items.map((item) => `probe:${item}`);
            },
        });

        await expect(queue.enqueue(1)).resolves.toBe('probe:1');
        expect(dispatches).toEqual([[1]]);

        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('revalidates capability on active only after the configured staleness interval', async () => {
        const lifecycle = getQueueLifecycleExports();
        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
        let now = 0;
        let revalidateCount = 0;
        const revalidateCapabilities = async () => {
            revalidateCount += 1;
            now += 7;
        };

        lifecycle.markNativeCryptoWorkerQueueQuiescent({ now: () => now });
        now = 999;
        await lifecycle.markNativeCryptoWorkerQueueActive({
            now: () => now,
            capabilityStalenessMs: 1_000,
            revalidateCapabilities,
        });
        expect(revalidateCount).toBe(0);

        lifecycle.markNativeCryptoWorkerQueueQuiescent({ now: () => now });
        now = 2_100;
        await lifecycle.markNativeCryptoWorkerQueueActive({
            now: () => now,
            capabilityStalenessMs: 1_000,
            revalidateCapabilities,
        });
        expect(revalidateCount).toBe(1);

        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('keeps regular dispatch blocked until stale resume capability revalidation finishes', async () => {
        const lifecycle = getQueueLifecycleExports();
        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
        let now = 0;
        const revalidation = createDeferred<void>();
        lifecycle.markNativeCryptoWorkerQueueQuiescent({ now: () => now });

        const dispatches: number[][] = [];
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 2,
            dispatch: async (items) => {
                dispatches.push([...items]);
                return items.map((item) => `r${item}`);
            },
        });
        const result = queue.enqueue(1);
        await Promise.resolve();

        now = 2_000;
        const active = lifecycle.markNativeCryptoWorkerQueueActive({
            now: () => now,
            capabilityStalenessMs: 1_000,
            revalidateCapabilities: () => revalidation.promise,
        });
        await Promise.resolve();
        expect(dispatches).toEqual([]);

        revalidation.resolve();
        await active;
        await expect(result).resolves.toBe('r1');
        expect(dispatches).toEqual([[1]]);

        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
    });

    it('dispatches one in-flight batch and preserves result order across pending batches', async () => {
        const firstDispatch = createDeferred<readonly string[]>();
        const dispatches: number[][] = [];
        let dispatchCount = 0;
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 2,
            dispatch: async (items) => {
                dispatches.push([...items]);
                dispatchCount += 1;
                if (dispatchCount === 1) {
                    return await firstDispatch.promise;
                }
                return items.map((item) => `r${item}`);
            },
        });

        const results = [queue.enqueue(1), queue.enqueue(2), queue.enqueue(3), queue.enqueue(4)];
        await Promise.resolve();
        expect(dispatches).toEqual([[1, 2]]);

        firstDispatch.resolve(['r1', 'r2']);
        await expect(Promise.all(results)).resolves.toEqual(['r1', 'r2', 'r3', 'r4']);
        expect(dispatches).toEqual([[1, 2], [3, 4]]);
    });

    it('rejects queued work when its signal aborts before dispatch', async () => {
        const firstDispatch = createDeferred<readonly string[]>();
        const controller = new AbortController();
        const dispatches: number[][] = [];
        let dispatchCount = 0;
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 1,
            dispatch: async (items) => {
                dispatches.push([...items]);
                dispatchCount += 1;
                if (dispatchCount === 1) {
                    return await firstDispatch.promise;
                }
                return items.map((item) => `r${item}`);
            },
        });

        const first = queue.enqueue(1);
        await Promise.resolve();
        expect(dispatches).toEqual([[1]]);

        const second = queue.enqueue(2, { signal: controller.signal });
        controller.abort();

        firstDispatch.resolve(['r1']);

        await expect(first).resolves.toBe('r1');
        await expect(second).rejects.toMatchObject({
            code: 'native_crypto_worker_queue_cancelled',
        });
        expect(dispatches).toEqual([[1]]);
    });

    it('rejects every item in a failed batch without blocking later batches', async () => {
        let dispatchCount = 0;
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 2,
            dispatch: async (items) => {
                dispatchCount += 1;
                if (dispatchCount === 1) {
                    throw new Error('batch failed');
                }
                return items.map((item) => `r${item}`);
            },
        });

        const first = Promise.allSettled([queue.enqueue(1), queue.enqueue(2)]);
        await Promise.resolve();
        const second = Promise.all([queue.enqueue(3), queue.enqueue(4)]);

        expect((await first).map((result) => result.status)).toEqual(['rejected', 'rejected']);
        await expect(second).resolves.toEqual(['r3', 'r4']);
    });

    it('rejects enqueues beyond one in-flight batch plus one pending batch with telemetry', async () => {
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            slowThresholdMs: 1_000_000,
        });
        const firstDispatch = createDeferred<readonly string[]>();
        let dispatchCount = 0;
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 2,
            operation: 'decryptSecretboxJson',
            telemetry,
            telemetryEnabled: true,
            dispatch: async (items) => {
                dispatchCount += 1;
                if (dispatchCount === 1) {
                    return await firstDispatch.promise;
                }
                return items.map((item) => `r${item}`);
            },
        });

        const accepted = [queue.enqueue(1), queue.enqueue(2), queue.enqueue(3), queue.enqueue(4)];
        await Promise.resolve();
        expect(queue.getQueueDepth()).toBe(2);

        const overflow = queue.enqueue(5);
        const overflowSettlement = await getPromiseSettlement(overflow);

        firstDispatch.resolve(['r1', 'r2']);
        await expect(Promise.all(accepted)).resolves.toEqual(['r1', 'r2', 'r3', 'r4']);

        expect(overflowSettlement).toMatchObject({
            status: 'rejected',
            reason: {
                code: 'native_crypto_worker_queue_backpressure',
            },
        });
        expect(queue.getQueueDepth()).toBeLessThanOrEqual(2);
        expect(telemetry.snapshot().events).toContainEqual(expect.objectContaining({
            name: 'sync.crypto.worker.queueBackpressure',
            fields: expect.objectContaining({
                operation: 2,
                queueDepth: 2,
                capacity: 2,
            }),
        }));
    });

    it('records queue depth and wait telemetry only when worker telemetry is enabled', async () => {
        let now = 0;
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            slowThresholdMs: 1_000_000,
            now: () => now,
        });
        const firstDispatch = createDeferred<readonly string[]>();
        let dispatchCount = 0;
        const queue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 1,
            operation: 'decryptSecretboxJson',
            telemetry,
            telemetryEnabled: true,
            now: () => now,
            dispatch: async (items) => {
                dispatchCount += 1;
                if (dispatchCount === 1) {
                    return await firstDispatch.promise;
                }
                return items.map((item) => `r${item}`);
            },
        });

        const first = queue.enqueue(1);
        await Promise.resolve();
        now = 25;
        const second = queue.enqueue(2);
        now = 50;

        firstDispatch.resolve(['r1']);
        await expect(Promise.all([first, second])).resolves.toEqual(['r1', 'r2']);

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.crypto.worker.queueDepth',
                fieldStats: expect.objectContaining({
                    operation: expect.objectContaining({ max: 2 }),
                    queueDepth: expect.objectContaining({ max: 1 }),
                }),
            }),
            expect.objectContaining({
                name: 'sync.crypto.worker.queueWaitMs',
                maxMs: 25,
                fieldStats: expect.objectContaining({
                    operation: expect.objectContaining({ max: 2 }),
                    items: expect.objectContaining({ max: 1 }),
                }),
            }),
        ]);

        const disabledTelemetry = createSyncPerformanceTelemetry({ enabled: true });
        const disabledQueue = createNativeCryptoWorkerBatchQueue<number, string>({
            maxBatchSize: 1,
            operation: 'decryptSecretboxJson',
            telemetry: disabledTelemetry,
            telemetryEnabled: false,
            dispatch: async (items) => items.map((item) => `r${item}`),
        });

        await expect(disabledQueue.enqueue(3)).resolves.toBe('r3');
        expect(disabledTelemetry.snapshot().events).toEqual([]);
    });

    it('reclaims drained per-generation queued batch entries after generation churn', async () => {
        const lifecycle = getQueueLifecycleExports();
        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();

        const owner = {};
        const dispatch = async (items: readonly number[]) => items.map((item) => `r${item}`);

        await expect(runNativeCryptoWorkerQueuedBatch({
            owner,
            operation: 'decryptSecretboxJson',
            scope: { accountId: 'account', serverId: 'server', generation: 1 },
            maxBatchSize: 2,
            items: [1, 2],
            dispatch,
        })).resolves.toEqual(['r1', 'r2']);
        expect(lifecycle.getNativeCryptoWorkerOwnerQueueCountForTests(owner)).toBe(0);

        await expect(runNativeCryptoWorkerQueuedBatch({
            owner,
            operation: 'decryptSecretboxJson',
            scope: { accountId: 'account', serverId: 'server', generation: 2 },
            maxBatchSize: 2,
            items: [3],
            dispatch,
        })).resolves.toEqual(['r3']);
        expect(lifecycle.getNativeCryptoWorkerOwnerQueueCountForTests(owner)).toBe(0);

        lifecycle.resetNativeCryptoWorkerQueueLifecycleForTests();
    });
});
