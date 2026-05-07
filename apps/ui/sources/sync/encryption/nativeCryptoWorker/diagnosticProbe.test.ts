import { describe, expect, it } from 'vitest';

import { createFakeCryptoWorker } from './fakeCryptoWorker';
import {
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type NativeCryptoWorker,
} from './types';

import { runNativeCryptoWorkerProbe } from './diagnosticProbe';

describe('runNativeCryptoWorkerProbe', () => {
    it('proves vector parity and invalid item isolation through the worker boundary', async () => {
        const report = await runNativeCryptoWorkerProbe({
            worker: createFakeCryptoWorker(),
            expectedBatchSource: 'reference',
            requireJsResponsiveness: false,
        });

        expect(report.checks.moduleAvailable.status).toBe('pass');
        expect(report.checks.batchSource.status).toBe('pass');
        expect(report.checks.dataKey.status).toBe('pass');
        expect(report.checks.secretbox.status).toBe('pass');
        expect(report.checks.aesGcm.status).toBe('pass');
        expect(report.checks.invalidItems.status).toBe('pass');
        expect(report.checks.jsResponsive.status).toBe('skipped');
        expect(report.status).toBe('pass');
        expect(report.evidence.dataKey).toMatchObject({ validItems: 5, nullItems: 2 });
        expect(report.evidence.secretbox).toMatchObject({ validItems: 9, nullItems: 2 });
        expect(report.evidence.aesGcm).toMatchObject({ validItems: 9, nullItems: 2 });
        expect(report.evidence.invalidItems).toMatchObject({ nullItems: 6, validItemsAfterInvalid: 3 });
    });

    it('includes lenient-valid base64 vectors in the runtime probe batches', async () => {
        const inner = createFakeCryptoWorker();
        const captured = {
            dataKey: [] as readonly unknown[],
            secretbox: [] as readonly unknown[],
            aesGcm: [] as readonly unknown[],
        };
        const worker: NativeCryptoWorker = {
            probe: inner.probe,
            async decryptDataKeyEnvelopeV1(request) {
                captured.dataKey = request.items;
                return inner.decryptDataKeyEnvelopeV1(request);
            },
            async decryptSecretboxJson(request) {
                captured.secretbox = request.items;
                return inner.decryptSecretboxJson(request);
            },
            async decryptAesGcmJson(request) {
                captured.aesGcm = request.items;
                return inner.decryptAesGcmJson(request);
            },
        };

        const report = await runNativeCryptoWorkerProbe({
            worker,
            expectedBatchSource: 'reference',
            requireJsResponsiveness: false,
        });

        expect(report.status).toBe('pass');
        expect(captured.dataKey).toEqual(expect.arrayContaining([
            expect.objectContaining({
                envelopeBase64: expect.stringMatching(/\s/),
            }),
            expect.objectContaining({
                recipientSecretKeyOrSeedBase64: expect.not.stringMatching(/=/),
            }),
        ]));
        expect(captured.secretbox).toEqual(expect.arrayContaining([
            expect.objectContaining({
                ciphertextBase64: expect.stringMatching(/\s/),
            }),
            expect.objectContaining({
                keyBase64: expect.not.stringMatching(/=/),
            }),
        ]));
        expect(captured.aesGcm).toEqual(expect.arrayContaining([
            expect.objectContaining({
                encryptedPayloadBase64: expect.stringMatching(/\s/),
            }),
            expect.objectContaining({
                keyBase64: expect.not.stringMatching(/=/),
            }),
        ]));
    });

    it('keeps native batch-source availability separate from JS vector parity', async () => {
        const report = await runNativeCryptoWorkerProbe({
            worker: createFakeCryptoWorker(),
            expectedBatchSource: 'native',
            requireJsResponsiveness: false,
        });

        expect(report.status).toBe('fail');
        expect(report.checks.batchSource.status).toBe('fail');
        expect(report.checks.dataKey.status).toBe('pass');
        expect(report.checks.secretbox.status).toBe('pass');
        expect(report.checks.aesGcm.status).toBe('pass');
        expect(report.evidence.batchSources).toEqual(['reference']);
    });

    it('reports typed unavailable capability evidence when probing throws', async () => {
        const probeError = Object.assign(new Error('probe failed before native module answered'), {
            code: 'native_probe_failed',
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.echoFailed,
        });
        const batchError = Object.assign(new Error('worker unavailable for data-key probe'), {
            code: 'native_batch_failed',
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
        });
        const worker: NativeCryptoWorker = {
            async probe() {
                throw probeError;
            },
            async decryptDataKeyEnvelopeV1() {
                throw batchError;
            },
            async decryptSecretboxJson() {
                throw new Error('worker unavailable');
            },
            async decryptAesGcmJson() {
                throw new Error('worker unavailable');
            },
        };

        const report = await runNativeCryptoWorkerProbe({
            worker,
            expectedBatchSource: 'native',
            requireJsResponsiveness: false,
        });

        expect(report.status).toBe('fail');
        expect(report.checks.moduleAvailable.status).toBe('fail');
        expect(report.checks.moduleAvailable.detail).toContain('code=native_probe_failed');
        expect(report.checks.moduleAvailable.detail).toContain('failureReason=2');
        expect(report.checks.moduleAvailable.detail).toContain('message=probe failed before native module answered');
        expect(report.checks.dataKey.detail).toContain('code=native_batch_failed');
        expect(report.checks.dataKey.detail).toContain('failureReason=1');
        expect(report.checks.dataKey.detail).toContain('message=worker unavailable for data-key probe');
        expect(report.evidence.capability).toEqual({
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown,
            nativeVersion: null,
            warmupMs: null,
            supportedOperations: [],
        });
    });
});
