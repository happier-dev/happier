import { requireNativeModule } from 'expo-modules-core';
import { parseSerializedJsonValue } from '@happier-dev/protocol';

import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type CryptoWorkerBatchRequest,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerCapability,
    type NativeCryptoWorkerDataKeyEnvelopeItem,
    type NativeCryptoWorkerOperation,
    type NativeCryptoWorkerProbeFailureReason,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';

type NativeCapabilitiesResult = Readonly<{
    moduleVersion?: unknown;
    platform?: unknown;
    supportedOperations?: unknown;
}>;

type HappierCryptoWorkerNativeModule = Readonly<{
    getCapabilities?: () => Promise<NativeCapabilitiesResult>;
    echoBatchForDiagnostics?: (values: readonly string[]) => Promise<readonly string[]>;
    decryptDataKeyEnvelopeV1Batch?: (
        items: readonly NativeCryptoWorkerDataKeyEnvelopeItem[],
    ) => Promise<readonly (string | null)[]>;
    decryptSecretboxJsonBatch?: (
        items: readonly NativeCryptoWorkerSecretboxJsonItem[],
    ) => Promise<readonly (string | null)[]>;
    decryptAesGcmJsonBatch?: (
        items: readonly NativeCryptoWorkerAesGcmJsonItem[],
    ) => Promise<readonly (string | null)[]>;
}>;

const probeEchoPayload = 'happier-crypto-worker-probe';

let nativeModule: HappierCryptoWorkerNativeModule | null | undefined;

function getNativeModule(): HappierCryptoWorkerNativeModule | null {
    if (nativeModule !== undefined) return nativeModule;
    try {
        nativeModule = requireNativeModule<HappierCryptoWorkerNativeModule>('HappierCryptoWorker');
    } catch {
        nativeModule = null;
    }
    return nativeModule;
}

function unavailable(reason: NativeCryptoWorkerProbeFailureReason): NativeCryptoWorkerCapability {
    return {
        available: false,
        failureReason: reason,
    };
}

function nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function normalizeNativeVersion(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const nativeVersion = Math.trunc(value);
    return nativeVersion > 0 ? nativeVersion : null;
}

function normalizeWarmupMs(startedAtMs: number): number {
    return Math.max(0, Math.trunc(nowMs() - startedAtMs));
}

function normalizeSupportedOperations(value: unknown): NativeCryptoWorkerOperation[] {
    if (!Array.isArray(value)) return [];
    const supported = new Set(Object.values(NATIVE_CRYPTO_WORKER_OPERATION));
    return value.filter((operation): operation is NativeCryptoWorkerOperation =>
        typeof operation === 'string' && supported.has(operation as NativeCryptoWorkerOperation)
    );
}

function parseNativeSerializedJsonItem(value: string | null): unknown | null {
    if (value === null) return null;
    try {
        return parseSerializedJsonValue(value);
    } catch {
        return null;
    }
}

async function probeNativeModule(module: HappierCryptoWorkerNativeModule): Promise<NativeCryptoWorkerCapability> {
    if (!module.getCapabilities || !module.echoBatchForDiagnostics) {
        return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
    }

    const startedAtMs = nowMs();
    const capabilities = await module.getCapabilities();
    const nativeVersion = normalizeNativeVersion(capabilities.moduleVersion);
    if (nativeVersion === null) {
        return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.wrongVersion);
    }

    const echo = await module.echoBatchForDiagnostics([probeEchoPayload]);
    if (echo.length !== 1 || echo[0] !== probeEchoPayload) {
        return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.echoFailed);
    }

    return {
        available: true,
        failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.ok,
        nativeVersion,
        warmupMs: normalizeWarmupMs(startedAtMs),
        supportedOperations: normalizeSupportedOperations(capabilities.supportedOperations),
    };
}

function unavailableResult<T>(request: CryptoWorkerBatchRequest<unknown>): NativeCryptoWorkerBatchResult<T> {
    if (request.signal?.aborted === true) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }
    throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
}

export function createNativeCryptoWorker(): NativeCryptoWorker {
    return {
        async probe() {
            const module = getNativeModule();
            if (!module) {
                return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
            }
            try {
                return await probeNativeModule(module);
            } catch {
                return unavailable(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown);
            }
        },
        async decryptDataKeyEnvelopeV1(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerDataKeyEnvelopeItem>,
        ): Promise<NativeCryptoWorkerBatchResult<string | null>> {
            if (request.signal?.aborted === true) {
                return { status: 'cancelled', source: 'cancelled', items: [] };
            }
            const module = getNativeModule();
            if (!module?.decryptDataKeyEnvelopeV1Batch) {
                return unavailableResult(request);
            }
            return {
                status: 'ok',
                source: 'native',
                items: await module.decryptDataKeyEnvelopeV1Batch(request.items),
            };
        },
        async decryptSecretboxJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerSecretboxJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            if (request.signal?.aborted === true) {
                return { status: 'cancelled', source: 'cancelled', items: [] };
            }
            const module = getNativeModule();
            if (!module?.decryptSecretboxJsonBatch) {
                return unavailableResult(request);
            }
            const items = await module.decryptSecretboxJsonBatch(request.items);
            return {
                status: 'ok',
                source: 'native',
                items: items.map(parseNativeSerializedJsonItem),
            };
        },
        async decryptAesGcmJson(
            request: CryptoWorkerBatchRequest<NativeCryptoWorkerAesGcmJsonItem>,
        ): Promise<NativeCryptoWorkerBatchResult<unknown | null>> {
            if (request.signal?.aborted === true) {
                return { status: 'cancelled', source: 'cancelled', items: [] };
            }
            const module = getNativeModule();
            if (!module?.decryptAesGcmJsonBatch) {
                return unavailableResult(request);
            }
            const items = await module.decryptAesGcmJsonBatch(request.items);
            return {
                status: 'ok',
                source: 'native',
                items: items.map(parseNativeSerializedJsonItem),
            };
        },
    };
}
