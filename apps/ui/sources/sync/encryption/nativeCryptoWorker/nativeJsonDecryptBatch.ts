import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import {
    bytesToCryptoWorkerBase64,
    estimateCryptoWorkerBatchBridgeBytes,
    estimateCryptoWorkerRawBatchBridgeBytes,
    estimateCryptoWorkerRawBytesBridgeBytes,
} from './nativeCryptoWorkerBridgePayload';
import { runNativeCryptoWorkerQueuedBatch } from './nativeCryptoWorkerQueue';
import {
    normalizeNativeCryptoWorkerRouting,
    type NativeCryptoWorkerRoutingInput,
    runNativeCryptoWorkerBatch,
} from './nativeCryptoWorkerRouting';
import { recordNativeCryptoWorkerBridgeSerialization } from './nativeCryptoWorkerTelemetry';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    type CryptoWorkerScope,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';

export type NativeJsonDecryptWorkerBinding = Readonly<{
    getWorker: () => NativeCryptoWorker;
    getRouting?: () => NativeCryptoWorkerRoutingInput;
    getScope: () => CryptoWorkerScope;
    isScopeCurrent?: (scope: CryptoWorkerScope) => boolean;
}>;

export type NativeJsonDecryptOptions = Readonly<{
    signal?: AbortSignal;
}>;

function nullItems(count: number): Array<unknown | null> {
    return Array.from({ length: count }, () => null);
}

function nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function shouldUseNativeWorkerAfterCheapChecks(
    routing: ReturnType<typeof normalizeNativeCryptoWorkerRouting>,
    itemCount: number,
): boolean {
    return routing.mode !== 'off' && itemCount >= routing.minBatchSize;
}

function estimatePayloadBytes(data: readonly Uint8Array[], key: Uint8Array): number {
    const ciphertextBytes = estimateCryptoWorkerRawBatchBridgeBytes(data).totalBridgeBytes;
    const keyBytes = estimateCryptoWorkerRawBytesBridgeBytes(key).totalBridgeBytes * data.length;
    return ciphertextBytes + keyBytes;
}

function estimateBase64PayloadBytes(data: readonly string[], key: Uint8Array): number {
    const ciphertextBytes = estimateCryptoWorkerBatchBridgeBytes(data).totalBridgeBytes;
    const keyBytes = estimateCryptoWorkerRawBytesBridgeBytes(key).totalBridgeBytes * data.length;
    return ciphertextBytes + keyBytes;
}

function recordBridgeSerializationIfEnabled(options: Readonly<{
    operation: typeof NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson | typeof NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson;
    telemetryEnabled: boolean;
    items: number;
    bytesIn: number;
    serializeMs: number;
}>): void {
    if (!options.telemetryEnabled || !syncPerformanceTelemetry.isEnabled()) return;
    recordNativeCryptoWorkerBridgeSerialization(syncPerformanceTelemetry, {
        operation: options.operation,
        items: options.items,
        bytesIn: options.bytesIn,
        bytesOut: 0,
        serializeMs: options.serializeMs,
    });
}

export async function decryptSecretboxJsonBatchWithNativeWorker(
    data: readonly Uint8Array[],
    key: Uint8Array,
    binding: NativeJsonDecryptWorkerBinding,
    referenceRun: () => Promise<readonly (unknown | null)[]>,
    options: NativeJsonDecryptOptions = {},
): Promise<Array<unknown | null>> {
    const routing = normalizeNativeCryptoWorkerRouting(binding.getRouting?.());
    if (!shouldUseNativeWorkerAfterCheapChecks(routing, data.length)) {
        return Array.from(await referenceRun());
    }
    const payloadBytes = estimatePayloadBytes(data, key);
    let resolvedWorker: NativeCryptoWorker | null = null;
    const getWorker = () => {
        resolvedWorker ??= binding.getWorker();
        return resolvedWorker;
    };
    let capturedScope: CryptoWorkerScope | null = null;
    const result = await runNativeCryptoWorkerBatch<unknown | null>({
        operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
        routing,
        itemCount: data.length,
        payloadBytes,
        capabilityCacheKey: getWorker(),
        signal: options.signal,
        probe: () => getWorker().probe(),
        nativeRun: async () => {
            const shouldMeasureSerialization = routing.telemetryEnabled && syncPerformanceTelemetry.isEnabled();
            const serializeStartedAtMs = shouldMeasureSerialization ? nowMs() : 0;
            let serializeMs = 0;
            const worker = getWorker();
            const scope = binding.getScope();
            capturedScope = scope;
            const ciphertextBase64 = data.map(bytesToCryptoWorkerBase64);
            const keyBase64 = bytesToCryptoWorkerBase64(key);
            const nativeItems = ciphertextBase64.map((ciphertext): NativeCryptoWorkerSecretboxJsonItem => ({
                ciphertextBase64: ciphertext,
                keyBase64,
            }));
            serializeMs = shouldMeasureSerialization ? Math.max(0, nowMs() - serializeStartedAtMs) : 0;
            try {
                return await runNativeCryptoWorkerQueuedBatch<NativeCryptoWorkerSecretboxJsonItem, unknown | null>({
                    owner: worker,
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
                    scope,
                    maxBatchSize: routing.maxBatchSize,
                    items: nativeItems,
                    telemetry: syncPerformanceTelemetry,
                    telemetryEnabled: routing.telemetryEnabled,
                    signal: options.signal,
                    dispatch: async (queuedItems, context) => {
                        const nativeResult = await worker.decryptSecretboxJson({
                            scope,
                            items: queuedItems,
                            signal: context.signal,
                        });
                        if (nativeResult.status !== 'ok') {
                            throw new Error('native secretbox JSON decrypt batch did not complete');
                        }
                        return nativeResult.items;
                    },
                });
            } finally {
                recordBridgeSerializationIfEnabled({
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
                    telemetryEnabled: routing.telemetryEnabled,
                    items: nativeItems.length,
                    bytesIn: payloadBytes,
                    serializeMs,
                });
            }
        },
        referenceRun,
        isScopeCurrent: binding.isScopeCurrent ? () => capturedScope !== null && binding.isScopeCurrent?.(capturedScope) === true : undefined,
    });

    return result.status === 'ok' ? Array.from(result.items) : nullItems(data.length);
}

export async function decryptSecretboxJsonBase64BatchWithNativeWorker(
    ciphertextBase64: readonly string[],
    key: Uint8Array,
    binding: NativeJsonDecryptWorkerBinding,
    referenceRun: () => Promise<readonly (unknown | null)[]>,
    options: NativeJsonDecryptOptions = {},
): Promise<Array<unknown | null>> {
    const routing = normalizeNativeCryptoWorkerRouting(binding.getRouting?.());
    if (!shouldUseNativeWorkerAfterCheapChecks(routing, ciphertextBase64.length)) {
        return Array.from(await referenceRun());
    }
    const payloadBytes = estimateBase64PayloadBytes(ciphertextBase64, key);
    let resolvedWorker: NativeCryptoWorker | null = null;
    const getWorker = () => {
        resolvedWorker ??= binding.getWorker();
        return resolvedWorker;
    };
    let capturedScope: CryptoWorkerScope | null = null;
    const result = await runNativeCryptoWorkerBatch<unknown | null>({
        operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
        routing,
        itemCount: ciphertextBase64.length,
        payloadBytes,
        capabilityCacheKey: getWorker(),
        signal: options.signal,
        probe: () => getWorker().probe(),
        nativeRun: async () => {
            const shouldMeasureSerialization = routing.telemetryEnabled && syncPerformanceTelemetry.isEnabled();
            const serializeStartedAtMs = shouldMeasureSerialization ? nowMs() : 0;
            let serializeMs = 0;
            const worker = getWorker();
            const scope = binding.getScope();
            capturedScope = scope;
            const keyBase64 = bytesToCryptoWorkerBase64(key);
            const nativeItems = ciphertextBase64.map((ciphertext): NativeCryptoWorkerSecretboxJsonItem => ({
                ciphertextBase64: ciphertext,
                keyBase64,
            }));
            serializeMs = shouldMeasureSerialization ? Math.max(0, nowMs() - serializeStartedAtMs) : 0;
            try {
                return await runNativeCryptoWorkerQueuedBatch<NativeCryptoWorkerSecretboxJsonItem, unknown | null>({
                    owner: worker,
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
                    scope,
                    maxBatchSize: routing.maxBatchSize,
                    items: nativeItems,
                    telemetry: syncPerformanceTelemetry,
                    telemetryEnabled: routing.telemetryEnabled,
                    signal: options.signal,
                    dispatch: async (queuedItems, context) => {
                        const nativeResult = await worker.decryptSecretboxJson({
                            scope,
                            items: queuedItems,
                            signal: context.signal,
                        });
                        if (nativeResult.status !== 'ok') {
                            throw new Error('native secretbox JSON decrypt batch did not complete');
                        }
                        return nativeResult.items;
                    },
                });
            } finally {
                recordBridgeSerializationIfEnabled({
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
                    telemetryEnabled: routing.telemetryEnabled,
                    items: nativeItems.length,
                    bytesIn: payloadBytes,
                    serializeMs,
                });
            }
        },
        referenceRun,
        isScopeCurrent: binding.isScopeCurrent ? () => capturedScope !== null && binding.isScopeCurrent?.(capturedScope) === true : undefined,
    });

    return result.status === 'ok' ? Array.from(result.items) : nullItems(ciphertextBase64.length);
}

export async function decryptAesGcmJsonBatchWithNativeWorker(
    data: readonly Uint8Array[],
    key: Uint8Array,
    binding: NativeJsonDecryptWorkerBinding,
    referenceRun: () => Promise<readonly (unknown | null)[]>,
    options: NativeJsonDecryptOptions = {},
): Promise<Array<unknown | null>> {
    const routing = normalizeNativeCryptoWorkerRouting(binding.getRouting?.());
    if (!shouldUseNativeWorkerAfterCheapChecks(routing, data.length)) {
        return Array.from(await referenceRun());
    }
    const payloadBytes = estimatePayloadBytes(data, key);
    let resolvedWorker: NativeCryptoWorker | null = null;
    const getWorker = () => {
        resolvedWorker ??= binding.getWorker();
        return resolvedWorker;
    };
    let capturedScope: CryptoWorkerScope | null = null;
    const result = await runNativeCryptoWorkerBatch<unknown | null>({
        operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
        routing,
        itemCount: data.length,
        payloadBytes,
        capabilityCacheKey: getWorker(),
        signal: options.signal,
        probe: () => getWorker().probe(),
        nativeRun: async () => {
            const shouldMeasureSerialization = routing.telemetryEnabled && syncPerformanceTelemetry.isEnabled();
            const serializeStartedAtMs = shouldMeasureSerialization ? nowMs() : 0;
            let serializeMs = 0;
            const worker = getWorker();
            const scope = binding.getScope();
            capturedScope = scope;
            const encryptedPayloadBase64 = data.map(bytesToCryptoWorkerBase64);
            const keyBase64 = bytesToCryptoWorkerBase64(key);
            const nativeItems = encryptedPayloadBase64.map((payload): NativeCryptoWorkerAesGcmJsonItem => ({
                encryptedPayloadBase64: payload,
                keyBase64,
            }));
            serializeMs = shouldMeasureSerialization ? Math.max(0, nowMs() - serializeStartedAtMs) : 0;
            try {
                return await runNativeCryptoWorkerQueuedBatch<NativeCryptoWorkerAesGcmJsonItem, unknown | null>({
                    owner: worker,
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
                    scope,
                    maxBatchSize: routing.maxBatchSize,
                    items: nativeItems,
                    telemetry: syncPerformanceTelemetry,
                    telemetryEnabled: routing.telemetryEnabled,
                    signal: options.signal,
                    dispatch: async (queuedItems, context) => {
                        const nativeResult = await worker.decryptAesGcmJson({
                            scope,
                            items: queuedItems,
                            signal: context.signal,
                        });
                        if (nativeResult.status !== 'ok') {
                            throw new Error('native AES-GCM JSON decrypt batch did not complete');
                        }
                        return nativeResult.items;
                    },
                });
            } finally {
                recordBridgeSerializationIfEnabled({
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
                    telemetryEnabled: routing.telemetryEnabled,
                    items: nativeItems.length,
                    bytesIn: payloadBytes,
                    serializeMs,
                });
            }
        },
        referenceRun,
        isScopeCurrent: binding.isScopeCurrent ? () => capturedScope !== null && binding.isScopeCurrent?.(capturedScope) === true : undefined,
    });

    return result.status === 'ok' ? Array.from(result.items) : nullItems(data.length);
}

export async function decryptAesGcmJsonBase64BatchWithNativeWorker(
    encryptedPayloadBase64: readonly string[],
    key: Uint8Array,
    binding: NativeJsonDecryptWorkerBinding,
    referenceRun: () => Promise<readonly (unknown | null)[]>,
    options: NativeJsonDecryptOptions = {},
): Promise<Array<unknown | null>> {
    const routing = normalizeNativeCryptoWorkerRouting(binding.getRouting?.());
    if (!shouldUseNativeWorkerAfterCheapChecks(routing, encryptedPayloadBase64.length)) {
        return Array.from(await referenceRun());
    }
    const payloadBytes = estimateBase64PayloadBytes(encryptedPayloadBase64, key);
    let resolvedWorker: NativeCryptoWorker | null = null;
    const getWorker = () => {
        resolvedWorker ??= binding.getWorker();
        return resolvedWorker;
    };
    let capturedScope: CryptoWorkerScope | null = null;
    const result = await runNativeCryptoWorkerBatch<unknown | null>({
        operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
        routing,
        itemCount: encryptedPayloadBase64.length,
        payloadBytes,
        capabilityCacheKey: getWorker(),
        signal: options.signal,
        probe: () => getWorker().probe(),
        nativeRun: async () => {
            const shouldMeasureSerialization = routing.telemetryEnabled && syncPerformanceTelemetry.isEnabled();
            const serializeStartedAtMs = shouldMeasureSerialization ? nowMs() : 0;
            let serializeMs = 0;
            const worker = getWorker();
            const scope = binding.getScope();
            capturedScope = scope;
            const keyBase64 = bytesToCryptoWorkerBase64(key);
            const nativeItems = encryptedPayloadBase64.map((payload): NativeCryptoWorkerAesGcmJsonItem => ({
                encryptedPayloadBase64: payload,
                keyBase64,
            }));
            serializeMs = shouldMeasureSerialization ? Math.max(0, nowMs() - serializeStartedAtMs) : 0;
            try {
                return await runNativeCryptoWorkerQueuedBatch<NativeCryptoWorkerAesGcmJsonItem, unknown | null>({
                    owner: worker,
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
                    scope,
                    maxBatchSize: routing.maxBatchSize,
                    items: nativeItems,
                    telemetry: syncPerformanceTelemetry,
                    telemetryEnabled: routing.telemetryEnabled,
                    signal: options.signal,
                    dispatch: async (queuedItems, context) => {
                        const nativeResult = await worker.decryptAesGcmJson({
                            scope,
                            items: queuedItems,
                            signal: context.signal,
                        });
                        if (nativeResult.status !== 'ok') {
                            throw new Error('native AES-GCM JSON decrypt batch did not complete');
                        }
                        return nativeResult.items;
                    },
                });
            } finally {
                recordBridgeSerializationIfEnabled({
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
                    telemetryEnabled: routing.telemetryEnabled,
                    items: nativeItems.length,
                    bytesIn: payloadBytes,
                    serializeMs,
                });
            }
        },
        referenceRun,
        isScopeCurrent: binding.isScopeCurrent ? () => capturedScope !== null && binding.isScopeCurrent?.(capturedScope) === true : undefined,
    });

    return result.status === 'ok' ? Array.from(result.items) : nullItems(encryptedPayloadBase64.length);
}
