import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    readNativeCryptoWorkerFallbackDiagnostics,
    resetNativeCryptoWorkerFallbackDiagnosticsForTests,
} from './nativeCryptoWorkerFallbackReport';
import {
    normalizeNativeCryptoWorkerRouting,
    resetNativeCryptoWorkerCapabilityCacheForTests,
    runNativeCryptoWorkerBatch,
} from './nativeCryptoWorkerRouting';
import { createNativeCryptoWorker as createWebNativeCryptoWorker } from './nativeCryptoWorker.web';
import { probeNativeCryptoWorkerCapabilities } from './probeNativeCryptoWorkerCapabilities';
import {
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type NativeCryptoWorker,
    type NativeCryptoWorkerCapability,
} from './types';

const availableCapability: NativeCryptoWorkerCapability = {
    available: true,
    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
    nativeVersion: 1,
};

const unavailableCapability: NativeCryptoWorkerCapability = {
    available: false,
    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
};

function createUnavailableWorker(): NativeCryptoWorker {
    return {
        probe: async () => unavailableCapability,
        async decryptDataKeyEnvelopeV1() {
            throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
        },
        async decryptSecretboxJson() {
            throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
        },
        async decryptAesGcmJson() {
            throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
        },
    };
}

async function runWithRouting(options: Readonly<{
    probe: () => Promise<NativeCryptoWorkerCapability>;
    nativeRun?: () => Promise<readonly string[]>;
}>) {
    return runNativeCryptoWorkerBatch({
        operation: 'decryptDataKeyEnvelopeV1',
        routing: { mode: 'auto', minPayloadBytes: 0 },
        itemCount: 4,
        payloadBytes: 50_000,
        probe: options.probe,
        nativeRun: options.nativeRun ?? (async () => ['native']),
        referenceRun: async () => ['reference'],
    });
}

describe('native crypto worker fallback visibility', () => {
    beforeEach(() => {
        resetNativeCryptoWorkerCapabilityCacheForTests();
        resetNativeCryptoWorkerFallbackDiagnosticsForTests();
    });

    it('starts with no recorded degradation', () => {
        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 0,
            lastReason: null,
        });
    });

    it('records a degradation when the native capability is unavailable', async () => {
        const result = await runWithRouting({ probe: async () => unavailableCapability });

        expect(result).toMatchObject({ status: 'ok', source: 'reference', items: ['reference'] });
        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 1,
            lastReason: 'unavailable',
            lastOperation: 'decryptDataKeyEnvelopeV1',
            countsByReason: expect.objectContaining({ unavailable: 1 }),
        });
    });

    it('records a degradation when the probe itself throws', async () => {
        await runWithRouting({
            probe: async () => {
                throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
            },
        });

        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 1,
            lastReason: 'probe_failed',
        });
    });

    it('records a degradation when the capability does not support the operation', async () => {
        await runWithRouting({
            probe: async () => ({ ...availableCapability, supportedOperations: ['decryptSecretboxJson'] }),
        });

        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 1,
            lastReason: 'unsupported_operation',
        });
    });

    it('records a degradation when the native run throws', async () => {
        await runWithRouting({
            probe: async () => availableCapability,
            nativeRun: async () => {
                throw new Error('native dispatch exploded');
            },
        });

        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 1,
            lastReason: 'native_run_failed',
        });
    });

    it('counts intentional routing decisions as declines, never as degradations', async () => {
        const nativeRun = vi.fn(async () => ['native']);

        await runNativeCryptoWorkerBatch({
            operation: 'decryptDataKeyEnvelopeV1',
            routing: { mode: 'off' },
            itemCount: 4,
            payloadBytes: 50_000,
            probe: async () => availableCapability,
            nativeRun,
            referenceRun: async () => ['reference'],
        });
        await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 4096 },
            itemCount: 1,
            payloadBytes: 128,
            probe: async () => availableCapability,
            nativeRun,
            referenceRun: async () => ['reference'],
        });
        await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minBatchSize: 8 },
            itemCount: 2,
            payloadBytes: 50_000,
            probe: async () => availableCapability,
            nativeRun,
            referenceRun: async () => ['reference'],
        });

        expect(nativeRun).not.toHaveBeenCalled();
        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 0,
            totalRoutingDeclines: 3,
            lastRoutingDeclineReason: 'below_min_batch_size',
            lastRoutingDeclineOperation: 'decryptSecretboxJson',
            routingDeclineCountsByReason: {
                routing_disabled: 1,
                below_min_payload_bytes: 1,
                below_min_batch_size: 1,
            },
        });
    });

    it('does not record a routing decline on a platform that has no native worker at all', async () => {
        // Same rule as for degradations: on web the JS path IS the implementation,
        // so a threshold that changed nothing must not appear as a lost opportunity.
        const webWorker = createWebNativeCryptoWorker();
        const capabilityCacheKey = {};

        await probeNativeCryptoWorkerCapabilities({ worker: webWorker, capabilityCacheKey, routing: { mode: 'auto' } });
        await runNativeCryptoWorkerBatch({
            operation: 'decryptSecretboxJson',
            routing: { mode: 'auto', minPayloadBytes: 4096 },
            itemCount: 1,
            payloadBytes: 128,
            capabilityCacheKey,
            probe: () => webWorker.probe(),
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });

        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 0,
            totalRoutingDeclines: 0,
            lastRoutingDeclineReason: null,
        });
    });

    it('does not report a degradation on a platform that has no native worker at all', async () => {
        // The web entry is a stub, not a broken native module: the JS path IS the
        // platform implementation there. Reporting it would drown the real signal
        // (a native build whose HappierCryptoWorker module is missing).
        const webWorker = createWebNativeCryptoWorker();

        await probeNativeCryptoWorkerCapabilities({ worker: webWorker, routing: { mode: 'auto' } });
        await runWithRouting({ probe: () => webWorker.probe() });

        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 0,
            lastReason: null,
        });
    });

    it('records the startup capability warm-up finding an unusable native module', async () => {
        const capability = await probeNativeCryptoWorkerCapabilities({
            worker: createUnavailableWorker(),
            routing: { mode: 'auto' },
        });

        expect(capability).toMatchObject({ available: false });
        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 1,
            lastReason: 'unavailable',
        });
    });

    it('honours the declared routing defaults for boolean switches', () => {
        expect(normalizeNativeCryptoWorkerRouting({ logFallbacks: 'yes' as never })).toMatchObject({
            logFallbacks: false,
        });
        expect(normalizeNativeCryptoWorkerRouting({ logFallbacks: true })).toMatchObject({
            logFallbacks: true,
        });
    });
});
