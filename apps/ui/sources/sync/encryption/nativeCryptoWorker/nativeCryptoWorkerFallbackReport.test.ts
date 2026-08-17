import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '@/log';

import {
    readNativeCryptoWorkerFallbackDiagnostics,
    resetNativeCryptoWorkerFallbackDiagnosticsForTests,
} from './nativeCryptoWorkerFallbackReport';
import {
    resetNativeCryptoWorkerCapabilityCacheForTests,
    runNativeCryptoWorkerBatch,
} from './nativeCryptoWorkerRouting';
import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
} from './types';

/**
 * Routing runs in `auto` mode with `logFallbacks` and `telemetryEnabled` both off by default, so a
 * build whose native worker is missing or broken used to degrade to JS crypto with no signal at all.
 * These tests pin that the default configuration is observable.
 */
function runBatchWithDefaults(overrides: Parameters<typeof runNativeCryptoWorkerBatch<string>>[0]) {
    return runNativeCryptoWorkerBatch<string>(overrides);
}

describe('native crypto worker fallback reporting', () => {
    beforeEach(() => {
        resetNativeCryptoWorkerFallbackDiagnosticsForTests();
        resetNativeCryptoWorkerCapabilityCacheForTests();
        vi.spyOn(log, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetNativeCryptoWorkerFallbackDiagnosticsForTests();
    });

    it('records and logs a degraded batch under the default (silent) routing configuration', async () => {
        const result = await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            routing: { mode: 'auto', minPayloadBytes: 0 },
            itemCount: 4,
            payloadBytes: 4096,
            capabilityCacheKey: {},
            probe: async () => ({
                available: false,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
            }),
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });

        expect(result.source).toBe('reference');
        const diagnostics = readNativeCryptoWorkerFallbackDiagnostics();
        expect(diagnostics.totalFallbacks).toBe(1);
        expect(diagnostics.countsByReason[NATIVE_CRYPTO_WORKER_FALLBACK_REASON.unavailable]).toBe(1);
        expect(diagnostics.lastOperation).toBe(NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1);
        expect(diagnostics.lastFailureReason).toBe(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
        expect(log.log).toHaveBeenCalledTimes(1);
    });

    it('distinguishes a failed probe from a failed native run', async () => {
        await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
            routing: { mode: 'auto', minPayloadBytes: 0 },
            itemCount: 2,
            payloadBytes: 2048,
            capabilityCacheKey: {},
            probe: async () => {
                throw new Error('probe exploded');
            },
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });

        await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
            routing: { mode: 'auto', minPayloadBytes: 0 },
            itemCount: 2,
            payloadBytes: 2048,
            capabilityCacheKey: {},
            probe: async () => ({
                available: true,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
                nativeVersion: 1,
            }),
            nativeRun: async () => {
                throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.echoFailed);
            },
            referenceRun: async () => ['reference'],
        });

        const diagnostics = readNativeCryptoWorkerFallbackDiagnostics();
        expect(diagnostics.totalFallbacks).toBe(2);
        expect(diagnostics.countsByReason[NATIVE_CRYPTO_WORKER_FALLBACK_REASON.probeFailed]).toBe(1);
        expect(diagnostics.countsByReason[NATIVE_CRYPTO_WORKER_FALLBACK_REASON.nativeRunFailed]).toBe(1);
        expect(diagnostics.lastReason).toBe(NATIVE_CRYPTO_WORKER_FALLBACK_REASON.nativeRunFailed);
    });

    it('logs one line per distinct degradation but keeps counting every occurrence', async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await runBatchWithDefaults({
                operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
                routing: { mode: 'auto', minPayloadBytes: 0 },
                itemCount: 1,
                payloadBytes: 1024,
                capabilityCacheKey: {},
                probe: async () => ({
                    available: false,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
                }),
                nativeRun: async () => ['native'],
                referenceRun: async () => ['reference'],
            });
        }

        expect(readNativeCryptoWorkerFallbackDiagnostics().totalFallbacks).toBe(3);
        expect(log.log).toHaveBeenCalledTimes(1);
    });

    it('logs every occurrence when routing asks for verbose fallback logging', async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await runBatchWithDefaults({
                operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
                routing: { mode: 'auto', minPayloadBytes: 0, logFallbacks: true },
                itemCount: 1,
                payloadBytes: 1024,
                capabilityCacheKey: {},
                probe: async () => ({
                    available: false,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
                }),
                nativeRun: async () => ['native'],
                referenceRun: async () => ['reference'],
            });
        }

        expect(log.log).toHaveBeenCalledTimes(3);
    });

    it('does not report a platform that has no native worker at all as a degradation', async () => {
        await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            routing: { mode: 'auto', minPayloadBytes: 0 },
            itemCount: 4,
            payloadBytes: 4096,
            capabilityCacheKey: {},
            probe: async () => ({
                available: false,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform,
            }),
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });

        expect(readNativeCryptoWorkerFallbackDiagnostics().totalFallbacks).toBe(0);
        expect(log.log).not.toHaveBeenCalled();
    });

    it('counts routing that intentionally stayed on the JS path as a decline, not a degradation', async () => {
        await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            routing: { mode: 'off' },
            itemCount: 4,
            payloadBytes: 4096,
            capabilityCacheKey: {},
            probe: async () => ({
                available: true,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
            }),
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });
        await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            routing: { mode: 'auto', minPayloadBytes: 4096 },
            itemCount: 1,
            payloadBytes: 505,
            capabilityCacheKey: {},
            probe: async () => ({
                available: true,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
            }),
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });

        // A declined batch and a broken worker look identical on a JS profile stack,
        // so the branch that chose the JS path has to be recorded — separately from
        // the degradation counters, which must stay clean.
        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 0,
            totalRoutingDeclines: 2,
            lastRoutingDeclineReason: 'below_min_payload_bytes',
            lastRoutingDeclineOperation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            routingDeclineCountsByReason: {
                routing_disabled: 1,
                below_min_payload_bytes: 1,
                below_min_batch_size: 0,
            },
        });
    });

    it('does not record a routing decline on a platform that has no native worker at all', async () => {
        const capabilityCacheKey = {};
        // Prime the capability the way startup warm-up does on web.
        await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            routing: { mode: 'auto', minPayloadBytes: 0 },
            itemCount: 4,
            payloadBytes: 4096,
            capabilityCacheKey,
            probe: async () => ({
                available: false,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform,
            }),
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });
        await runBatchWithDefaults({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            routing: { mode: 'auto', minPayloadBytes: 4096 },
            itemCount: 1,
            payloadBytes: 505,
            capabilityCacheKey,
            probe: async () => ({
                available: false,
                failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform,
            }),
            nativeRun: async () => ['native'],
            referenceRun: async () => ['reference'],
        });

        expect(readNativeCryptoWorkerFallbackDiagnostics()).toMatchObject({
            totalFallbacks: 0,
            totalRoutingDeclines: 0,
            lastRoutingDeclineReason: null,
        });
    });
});
