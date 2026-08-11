import {
    syncPerformanceTelemetry,
    type SyncPerformanceTelemetry,
} from '@/sync/runtime/syncPerformanceTelemetry';

import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON,
    NativeCryptoWorkerUnavailableError,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerCapability,
    type NativeCryptoWorkerFallbackReason,
    type NativeCryptoWorkerOperation,
    type NativeCryptoWorkerRoutingDeclineReason,
} from './types';
import { recordNativeCryptoWorkerStaleScopeDropForResume } from './nativeCryptoWorkerQueue';
import {
    reportNativeCryptoWorkerFallback,
    reportNativeCryptoWorkerRoutingDecline,
} from './nativeCryptoWorkerFallbackReport';
import { recordNativeCryptoWorkerProbe } from './nativeCryptoWorkerTelemetry';

export type NativeCryptoWorkerMode = 'off' | 'auto' | 'require';

export type NativeCryptoWorkerRoutingInput = Partial<Readonly<{
    mode: NativeCryptoWorkerMode;
    maxBatchSize: number;
    minBatchSize: number;
    minPayloadBytes: number;
    timeoutMs: number;
    logFallbacks: boolean;
    telemetryEnabled: boolean;
    streamingSampleRate: number;
    capabilityStalenessMs: number;
}>>;

export type NativeCryptoWorkerRouting = Required<NativeCryptoWorkerRoutingInput>;

export const DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING: NativeCryptoWorkerRouting = {
    mode: 'off',
    maxBatchSize: 64,
    minBatchSize: 1,
    minPayloadBytes: 512,
    timeoutMs: 5000,
    logFallbacks: false,
    telemetryEnabled: false,
    streamingSampleRate: 1,
    capabilityStalenessMs: 300_000,
};

type RunNativeCryptoWorkerBatchOptions<T> = Readonly<{
    operation: NativeCryptoWorkerOperation;
    routing?: NativeCryptoWorkerRoutingInput;
    itemCount: number;
    payloadBytes: number;
    capabilityCacheKey?: object;
    signal?: AbortSignal;
    telemetry?: SyncPerformanceTelemetry;
    now?: () => number;
    probe: () => Promise<NativeCryptoWorkerCapability>;
    nativeRun: () => Promise<readonly T[]>;
    referenceRun: () => Promise<readonly T[]>;
    isScopeCurrent?: () => boolean;
}>;

let nativeCryptoWorkerCapabilityCache = new WeakMap<object, NativeCryptoWorkerCapability>();

function normalizeIntegerRange(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.trunc(value)))
        : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeRatio(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : fallback;
}

function normalizeMode(mode: unknown): NativeCryptoWorkerMode {
    return mode === 'auto' || mode === 'require' || mode === 'off'
        ? mode
        : DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.mode;
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

function defaultNow(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function isNativeWorkerUnavailableError(error: unknown): boolean {
    if (error instanceof NativeCryptoWorkerUnavailableError) return true;
    return typeof error === 'object'
        && error !== null
        && (error as { code?: unknown }).code === 'native_crypto_worker_unavailable';
}

function getNativeWorkerFailureReason(error: unknown) {
    if (error instanceof NativeCryptoWorkerUnavailableError) {
        return error.failureReason;
    }
    if (
        typeof error === 'object'
        && error !== null
        && typeof (error as { failureReason?: unknown }).failureReason === 'number'
    ) {
        return (error as { failureReason: NativeCryptoWorkerCapability['failureReason'] }).failureReason;
    }
    return NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown;
}

function doesCapabilityExplicitlySupportOperation(
    capability: NativeCryptoWorkerCapability,
    operation: NativeCryptoWorkerOperation,
): boolean {
    const supportedOperations = capability.supportedOperations;
    if (!supportedOperations || supportedOperations.length === 0) {
        return true;
    }
    return supportedOperations.includes(operation);
}

export function normalizeNativeCryptoWorkerRouting(input: NativeCryptoWorkerRoutingInput = {}): NativeCryptoWorkerRouting {
    return {
        mode: normalizeMode(input.mode),
        maxBatchSize: normalizeIntegerRange(input.maxBatchSize, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.maxBatchSize, 1, 512),
        minBatchSize: normalizeIntegerRange(input.minBatchSize, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.minBatchSize, 1, 512),
        minPayloadBytes: normalizeIntegerRange(input.minPayloadBytes, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.minPayloadBytes, 0, 65_536),
        timeoutMs: normalizeIntegerRange(input.timeoutMs, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.timeoutMs, 100, 60_000),
        logFallbacks: normalizeBoolean(input.logFallbacks, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.logFallbacks),
        telemetryEnabled: normalizeBoolean(input.telemetryEnabled, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.telemetryEnabled),
        streamingSampleRate: normalizeRatio(input.streamingSampleRate, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.streamingSampleRate),
        capabilityStalenessMs: normalizeIntegerRange(input.capabilityStalenessMs, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.capabilityStalenessMs, 1_000, 3_600_000),
    };
}

async function runReference<T>(referenceRun: () => Promise<readonly T[]>): Promise<NativeCryptoWorkerBatchResult<T>> {
    return {
        status: 'ok',
        source: 'reference',
        items: await referenceRun(),
    };
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            fn(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('native crypto worker timed out')), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function runProbe<T>(
    options: RunNativeCryptoWorkerBatchOptions<T>,
    routing: NativeCryptoWorkerRouting,
): Promise<NativeCryptoWorkerCapability> {
    if (options.capabilityCacheKey) {
        const cached = nativeCryptoWorkerCapabilityCache.get(options.capabilityCacheKey);
        if (cached) {
            return cached;
        }
    }

    const telemetry = options.telemetry ?? syncPerformanceTelemetry;
    const shouldRecordProbe = routing.telemetryEnabled && telemetry.isEnabled();
    if (!shouldRecordProbe) {
        const capability = await runWithTimeout(options.probe, routing.timeoutMs);
        rememberNativeCryptoWorkerCapability(options.capabilityCacheKey, capability);
        return capability;
    }

    const now = options.now ?? defaultNow;
    const startedAtMs = now();
    try {
        const capability = await runWithTimeout(options.probe, routing.timeoutMs);
        rememberNativeCryptoWorkerCapability(options.capabilityCacheKey, capability);
        recordNativeCryptoWorkerProbe(telemetry, Math.max(0, now() - startedAtMs), {
            operation: options.operation,
            items: options.itemCount,
            payloadBytes: options.payloadBytes,
            available: capability.available,
            failureReason: capability.failureReason,
            warmupMs: capability.warmupMs ?? 0,
        });
        return capability;
    } catch (error) {
        invalidateNativeCryptoWorkerCapability(options.capabilityCacheKey);
        recordNativeCryptoWorkerProbe(telemetry, Math.max(0, now() - startedAtMs), {
            operation: options.operation,
            items: options.itemCount,
            payloadBytes: options.payloadBytes,
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown,
            warmupMs: 0,
        });
        throw error;
    }
}

export function rememberNativeCryptoWorkerCapability(
    cacheKey: object | undefined,
    capability: NativeCryptoWorkerCapability,
): void {
    if (!cacheKey) return;
    nativeCryptoWorkerCapabilityCache.set(cacheKey, capability);
}

export function degradeNativeCryptoWorkerCapability(
    cacheKey: object | undefined,
    failureReason: NativeCryptoWorkerCapability['failureReason'],
): void {
    if (!cacheKey) return;
    rememberNativeCryptoWorkerCapability(cacheKey, {
        available: false,
        failureReason,
    });
}

export function invalidateNativeCryptoWorkerCapability(cacheKey: object | undefined): void {
    if (!cacheKey) return;
    nativeCryptoWorkerCapabilityCache.delete(cacheKey);
}

export function resetNativeCryptoWorkerCapabilityCacheForTests(): void {
    nativeCryptoWorkerCapabilityCache = new WeakMap<object, NativeCryptoWorkerCapability>();
}

export async function runNativeCryptoWorkerBatch<T>(
    options: RunNativeCryptoWorkerBatchOptions<T>,
): Promise<NativeCryptoWorkerBatchResult<T>> {
    const routing = normalizeNativeCryptoWorkerRouting(options.routing);
    if (isAbortSignalAborted(options.signal)) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }

    const declineReason: NativeCryptoWorkerRoutingDeclineReason | null = routing.mode === 'off'
        ? NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON.routingDisabled
        : options.itemCount < routing.minBatchSize
            ? NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON.belowMinBatchSize
            : options.payloadBytes < routing.minPayloadBytes
                ? NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON.belowMinPayloadBytes
                : null;
    if (declineReason !== null) {
        // A decline is silent to the profiler: the batch simply appears on the JS
        // reference stack, exactly like a broken worker does. Record which branch
        // chose it so the two are distinguishable without re-deriving the arithmetic.
        const lastKnownCapability = options.capabilityCacheKey
            ? nativeCryptoWorkerCapabilityCache.get(options.capabilityCacheKey)
            : undefined;
        reportNativeCryptoWorkerRoutingDecline({
            operation: options.operation,
            reason: declineReason,
            itemCount: options.itemCount,
            payloadBytes: options.payloadBytes,
            threshold: declineReason === NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON.belowMinBatchSize
                ? routing.minBatchSize
                : declineReason === NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON.belowMinPayloadBytes
                    ? routing.minPayloadBytes
                    : null,
            lastKnownFailureReason: lastKnownCapability && !lastKnownCapability.available
                ? lastKnownCapability.failureReason
                : null,
            verbose: routing.logFallbacks,
        });
        return runReference(options.referenceRun);
    }

    const reportFallback = (
        reason: NativeCryptoWorkerFallbackReason,
        failureReason: number | null,
        error?: unknown,
    ): void => {
        reportNativeCryptoWorkerFallback({
            operation: options.operation,
            reason,
            itemCount: options.itemCount,
            payloadBytes: options.payloadBytes,
            failureReason,
            error,
            verbose: routing.logFallbacks,
            telemetry: options.telemetry ?? syncPerformanceTelemetry,
            telemetryEnabled: routing.telemetryEnabled,
        });
    };

    let capability: NativeCryptoWorkerCapability;
    try {
        capability = await runProbe(options, routing);
    } catch (error) {
        invalidateNativeCryptoWorkerCapability(options.capabilityCacheKey);
        degradeNativeCryptoWorkerCapability(options.capabilityCacheKey, getNativeWorkerFailureReason(error));
        if (routing.mode === 'require') {
            throw error;
        }
        reportFallback(NATIVE_CRYPTO_WORKER_FALLBACK_REASON.probeFailed, getNativeWorkerFailureReason(error), error);
        return runReference(options.referenceRun);
    }
    if (!capability.available) {
        if (routing.mode === 'require') {
            throw new NativeCryptoWorkerUnavailableError(capability.failureReason);
        }
        reportFallback(NATIVE_CRYPTO_WORKER_FALLBACK_REASON.unavailable, capability.failureReason);
        return runReference(options.referenceRun);
    }
    if (!doesCapabilityExplicitlySupportOperation(capability, options.operation)) {
        if (routing.mode === 'require') {
            throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
        }
        reportFallback(
            NATIVE_CRYPTO_WORKER_FALLBACK_REASON.unsupportedOperation,
            NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
        );
        return runReference(options.referenceRun);
    }
    if (isAbortSignalAborted(options.signal)) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }

    try {
        const items = await runWithTimeout(options.nativeRun, routing.timeoutMs);
        if (isAbortSignalAborted(options.signal)) {
            return { status: 'cancelled', source: 'cancelled', items: [] };
        }
        if (options.isScopeCurrent && !options.isScopeCurrent()) {
            recordNativeCryptoWorkerStaleScopeDropForResume();
            return { status: 'stale', source: 'native', items: [] };
        }
        return { status: 'ok', source: 'native', items };
    } catch (error) {
        if (isAbortSignalAborted(options.signal)) {
            return { status: 'cancelled', source: 'cancelled', items: [] };
        }
        if (isNativeWorkerUnavailableError(error)) {
            invalidateNativeCryptoWorkerCapability(options.capabilityCacheKey);
        } else {
            degradeNativeCryptoWorkerCapability(options.capabilityCacheKey, getNativeWorkerFailureReason(error));
        }
        if (routing.mode === 'require') {
            throw error;
        }
        reportFallback(NATIVE_CRYPTO_WORKER_FALLBACK_REASON.nativeRunFailed, getNativeWorkerFailureReason(error), error);
        return runReference(options.referenceRun);
    }
}

export const NATIVE_CRYPTO_WORKER_UNAVAILABLE_CAPABILITY: NativeCryptoWorkerCapability = {
    available: false,
    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
};
