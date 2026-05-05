import { describe, expect, it } from 'vitest';

import { createSyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import {
    recordNativeCryptoWorkerAppStateActive,
    recordNativeCryptoWorkerAppStateQuiescent,
    recordNativeCryptoWorkerBridgeSerialization,
    recordNativeCryptoWorkerCapability,
} from './nativeCryptoWorkerTelemetry';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
} from './types';

describe('native crypto worker telemetry', () => {
    it('emits only numeric aggregate fields for bridge serialization', () => {
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });

        recordNativeCryptoWorkerBridgeSerialization(telemetry, {
            operation: 'decryptDataKeyEnvelopeV1',
            items: 4,
            bytesIn: 128,
            bytesOut: 64,
            serializeMs: 7,
        });

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.crypto.worker.bridgeSerialize',
                fields: {
                    operation: 1,
                    items: 4,
                    bytesIn: 128,
                    bytesOut: 64,
                    serializeMs: 7,
                },
            }),
        ]);
    });

    it('encodes capability failures as numeric reasons', () => {
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });

        const capability = {
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.echoFailed,
            warmupMs: 12,
            supportedOperations: [NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1],
        } as const;

        recordNativeCryptoWorkerCapability(telemetry, capability, { mode: 'auto' });

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.crypto.worker.capability',
                fields: {
                    workerMode: 1,
                    available: 0,
                    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.echoFailed,
                    warmupMs: 12,
                    supportsDecryptDataKeyEnvelopeV1: 1,
                    supportsDecryptSecretboxJson: 0,
                    supportsDecryptAesGcmJson: 0,
                },
            }),
        ]);
    });

    it('emits only numeric aggregate fields for AppState quiesce and active events', () => {
        const telemetry = createSyncPerformanceTelemetry({ enabled: true });

        recordNativeCryptoWorkerAppStateQuiescent(telemetry, {
            queueDepth: 3,
            inFlightCount: 1,
        });
        recordNativeCryptoWorkerAppStateActive(telemetry, {
            queuedDuringQuiesceCount: 2,
            capabilityRevalidatedMs: 7,
            staleScopeDropsOnResume: 0,
        });

        expect(telemetry.snapshot().events).toEqual([
            expect.objectContaining({
                name: 'sync.crypto.worker.appStateQuiescent',
                fields: {
                    queueDepth: 3,
                    inFlightCount: 1,
                },
            }),
            expect.objectContaining({
                name: 'sync.crypto.worker.appStateActive',
                fields: {
                    queuedDuringQuiesceCount: 2,
                    capabilityRevalidatedMs: 7,
                    staleScopeDropsOnResume: 0,
                },
            }),
        ]);
    });
});
