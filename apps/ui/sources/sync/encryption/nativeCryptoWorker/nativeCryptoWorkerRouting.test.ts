import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';
import { createSyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { runNativeCryptoWorkerQueuedBatch } from './nativeCryptoWorkerQueue';
import {
    normalizeNativeCryptoWorkerRouting,
    resetNativeCryptoWorkerCapabilityCacheForTests,
    runNativeCryptoWorkerBatch,
} from './nativeCryptoWorkerRouting';
import {
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type NativeCryptoWorkerCapability,
} from './types';

const unavailableCapability: NativeCryptoWorkerCapability = {
    available: false,
    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
};

const availableCapability: NativeCryptoWorkerCapability = {
    available: true,
    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
    nativeVersion: 1,
};

describe('normalizeNativeCryptoWorkerRouting', () => {
    it('pins canonical defaults', () => {
        expect(normalizeNativeCryptoWorkerRouting()).toMatchObject({
            mode: 'off',
            maxBatchSize: 64,
            minBatchSize: 1,
            minPayloadBytes: 512,
            timeoutMs: 5000,
            logFallbacks: false,
            telemetryEnabled: false,
            streamingSampleRate: 1,
            capabilityStalenessMs: 300_000,
        });
    });

    it('clamps invalid values without accepting unsafe mode strings', () => {
        expect(normalizeNativeCryptoWorkerRouting({
            mode: 'require',
            maxBatchSize: 0,
            minBatchSize: 0,
            minPayloadBytes: -1,
            timeoutMs: 0,
            streamingSampleRate: 2,
            capabilityStalenessMs: 10,
        })).toMatchObject({
            mode: 'require',
            maxBatchSize: 1,
            minBatchSize: 1,
            minPayloadBytes: 0,
            timeoutMs: 100,
            streamingSampleRate: 1,
            capabilityStalenessMs: 1000,
        });

        expect(normalizeNativeCryptoWorkerRouting({ mode: 'unexpected' as never }).mode).toBe('off');
        expect(normalizeNativeCryptoWorkerRouting()).not.toHaveProperty('internalParallelism');
    });

    it('clamps production dispatch ranges to the documented table', () => {
        expect(normalizeNativeCryptoWorkerRouting({
            maxBatchSize: 999,
            minPayloadBytes: 999_999,
            timeoutMs: 50,
            capabilityStalenessMs: 9_999_999,
        })).toMatchObject({
            maxBatchSize: 512,
            minPayloadBytes: 65_536,
            timeoutMs: 100,
            capabilityStalenessMs: 3_600_000,
        });
    });
});

describe('runNativeCryptoWorkerBatch', () => {
    beforeEach(() => {
        resetNativeCryptoWorkerCapabilityCacheForTests();
    });

    it('uses reference work without probing native when mode is off', async () => {
        const probe = vi.fn(async () => availableCapability);
        const nativeRun = vi.fn(async () => ['native']);
        const referenceRun = vi.fn(async () => ['reference']);

        const result = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'off' },
            itemCount: 4,
            payloadBytes: 50_000,
            probe,
            nativeRun,
            referenceRun,
        });

        expect(result).toEqual({ status: 'ok', source: 'reference', items: ['reference'] });
        expect(probe).not.toHaveBeenCalled();
        expect(nativeRun).not.toHaveBeenCalled();
        expect(referenceRun).toHaveBeenCalledTimes(1);
    });

    it('falls back in auto mode when native is unavailable', async () => {
        const result = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto' },
            itemCount: 4,
            payloadBytes: 50_000,
            probe: async () => unavailableCapability,
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });

        expect(result).toEqual({ status: 'ok', source: 'reference', items: ['reference'] });
    });

    it('fails in require mode when native is unavailable', async () => {
        await expect(runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'require' },
            itemCount: 4,
            payloadBytes: 50_000,
            probe: async () => unavailableCapability,
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        })).rejects.toMatchObject({
            code: 'native_crypto_worker_unavailable',
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
        });
    });

    it('uses reference work for batches below payload threshold', async () => {
        const probe = vi.fn(async () => availableCapability);
        const nativeRun = vi.fn(async () => ['native']);
        const referenceRun = vi.fn(async () => ['reference']);

        const result = await runNativeCryptoWorkerBatch({
            operation: 'decryptDataKeyEnvelopeV1',
            routing: { mode: 'auto', minPayloadBytes: 512 },
            itemCount: 3,
            payloadBytes: 128,
            probe,
            nativeRun,
            referenceRun,
        });

        expect(result.source).toBe('reference');
        expect(probe).not.toHaveBeenCalled();
        expect(nativeRun).not.toHaveBeenCalled();
    });

    it('returns cancelled when a signal aborts queued native work before dispatch', async () => {
        const owner = {};
        const scope = { accountId: 'account', serverId: 'server', generation: 1 };
        const firstDispatch = createDeferred<readonly string[]>();
        const controller = new AbortController();
        const dispatches: string[][] = [];
        let dispatchCount = 0;
        const dispatch = async (items: readonly string[]) => {
            dispatches.push([...items]);
            dispatchCount += 1;
            if (dispatchCount === 1) {
                return await firstDispatch.promise;
            }
            return items.map((item) => `native:${item}`);
        };
        const first = runNativeCryptoWorkerQueuedBatch({
            owner,
            operation: 'decryptSecretboxJson',
            scope,
            maxBatchSize: 1,
            items: ['first'],
            dispatch,
        });
        await Promise.resolve();
        expect(dispatches).toEqual([['first']]);

        const referenceRun = vi.fn(async () => ['reference']);
        const result = runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 0 },
            itemCount: 1,
            payloadBytes: 1,
            signal: controller.signal,
            probe: async () => availableCapability,
            nativeRun: () => runNativeCryptoWorkerQueuedBatch({
                owner,
                operation: 'decryptSecretboxJson',
                scope,
                maxBatchSize: 1,
                items: ['second'],
                signal: controller.signal,
                dispatch,
            }),
            referenceRun,
        });
        await Promise.resolve();
        controller.abort();

        firstDispatch.resolve(['native:first']);

        await expect(first).resolves.toEqual(['native:first']);
        await expect(result).resolves.toEqual({ status: 'cancelled', source: 'cancelled', items: [] });
        expect(referenceRun).not.toHaveBeenCalled();
        expect(dispatches).toEqual([['first']]);
    });

    it('drops cancelled batches before dispatch', async () => {
        const controller = new AbortController();
        controller.abort();
        const nativeRun = vi.fn(async () => ['native']);
        const referenceRun = vi.fn(async () => ['reference']);

        const result = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto' },
            itemCount: 4,
            payloadBytes: 50_000,
            signal: controller.signal,
            probe: async () => availableCapability,
            nativeRun,
            referenceRun,
        });

        expect(result).toEqual({ status: 'cancelled', source: 'cancelled', items: [] });
        expect(nativeRun).not.toHaveBeenCalled();
        expect(referenceRun).not.toHaveBeenCalled();
    });

    it('drops stale native results after dispatch', async () => {
        const result = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto' },
            itemCount: 4,
            payloadBytes: 50_000,
            probe: async () => availableCapability,
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
            isScopeCurrent: () => false,
        });

        expect(result).toEqual({ status: 'stale', source: 'native', items: [] });
    });

    it('records per-dispatch native capability probe duration when telemetry is enabled', async () => {
        let now = 100;
        const telemetry = createSyncPerformanceTelemetry({
            enabled: true,
            slowThresholdMs: 1,
            now: () => now,
        });

        const result = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 0, telemetryEnabled: true },
            telemetry,
            now: () => now,
            itemCount: 2,
            payloadBytes: 2048,
            probe: async () => {
                now = 107;
                return {
                    ...availableCapability,
                    warmupMs: 6,
                };
            },
            nativeRun: async () => ['native-a', 'native-b'],
            referenceRun: async () => ['reference'],
        });

        expect(result).toEqual({ status: 'ok', source: 'native', items: ['native-a', 'native-b'] });
        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.crypto.worker.probe',
                count: 1,
                totalMs: 7,
                p99Ms: 16,
                fields: expect.objectContaining({
                    operation: 2,
                    items: 2,
                    payloadBytes: 2048,
                    available: 1,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                    warmupMs: 6,
                }),
            }),
        ]);
    });

    it('invalidates a cached capability when native dispatch reports the module unavailable', async () => {
        const capabilityCacheKey = {};
        let probeCount = 0;
        let dispatchCount = 0;

        const first = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 0 },
            capabilityCacheKey,
            itemCount: 2,
            payloadBytes: 2048,
            probe: async () => {
                probeCount += 1;
                return availableCapability;
            },
            nativeRun: async () => {
                dispatchCount += 1;
                throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
            },
            referenceRun: async () => ['reference-after-unavailable'],
        });

        expect(first).toEqual({
            status: 'ok',
            source: 'reference',
            items: ['reference-after-unavailable'],
        });

        const second = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 0 },
            capabilityCacheKey,
            itemCount: 2,
            payloadBytes: 2048,
            probe: async () => {
                probeCount += 1;
                return availableCapability;
            },
            nativeRun: async () => {
                dispatchCount += 1;
                return ['native-after-reprobe'];
            },
            referenceRun: async () => ['reference'],
        });

        expect(second).toEqual({
            status: 'ok',
            source: 'native',
            items: ['native-after-reprobe'],
        });
        expect(dispatchCount).toBe(2);
        expect(probeCount).toBe(2);
    });

    it('degrades a cached capability after a native decrypt failure in auto mode', async () => {
        const capabilityCacheKey = {};
        let probeCount = 0;
        let dispatchCount = 0;

        const first = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 0 },
            capabilityCacheKey,
            itemCount: 2,
            payloadBytes: 2048,
            probe: async () => {
                probeCount += 1;
                return availableCapability;
            },
            nativeRun: async () => {
                dispatchCount += 1;
                throw new Error('native bridge crashed');
            },
            referenceRun: async () => ['reference-after-runtime-failure'],
        });

        expect(first).toEqual({
            status: 'ok',
            source: 'reference',
            items: ['reference-after-runtime-failure'],
        });

        const second = await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 0 },
            capabilityCacheKey,
            itemCount: 2,
            payloadBytes: 2048,
            probe: async () => {
                probeCount += 1;
                return availableCapability;
            },
            nativeRun: async () => {
                dispatchCount += 1;
                return ['native-after-degrade'];
            },
            referenceRun: async () => ['reference-after-degrade'],
        });

        expect(second).toEqual({
            status: 'ok',
            source: 'reference',
            items: ['reference-after-degrade'],
        });
        expect(dispatchCount).toBe(1);
        expect(probeCount).toBe(1);
    });
});
