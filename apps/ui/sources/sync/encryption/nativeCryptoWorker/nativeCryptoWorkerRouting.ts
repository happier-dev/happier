import { Platform } from 'react-native';
import {
    syncPerformanceTelemetry,
    type SyncPerformanceTelemetry,
} from '@/sync/runtime/syncPerformanceTelemetry';

import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON,
    NativeCryptoWorkerUnavailableError,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerCapability,
    type NativeCryptoWorkerFallbackReason,
    type NativeCryptoWorkerOperation,
    type NativeCryptoWorkerRoutingDeclineReason,
} from './types';
import {
    recordNativeCryptoWorkerStaleScopeDropForResume,
    whenNativeCryptoWorkerRegularDispatchResumed,
} from './nativeCryptoWorkerQueue';
import { recordNativeCryptoWorkerProbe } from './nativeCryptoWorkerTelemetry';
import {
    reportNativeCryptoWorkerFallback,
    reportNativeCryptoWorkerRoutingDecline,
} from './nativeCryptoWorkerFallbackReport';

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
    nativeRun: (signal?: AbortSignal) => Promise<readonly T[]>;
    referenceRun: () => Promise<readonly T[]>;
    isScopeCurrent?: () => boolean;
}>;

let nativeCryptoWorkerCapabilityCache = new WeakMap<object, NativeCryptoWorkerCapability>();

function normalizeIntegerRange(value: unknown, fallback: number, min: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.trunc(value)))
        : fallback;
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

export function normalizeNativeCryptoWorkerRouting(input: NativeCryptoWorkerRoutingInput = {}): NativeCryptoWorkerRouting {
    return {
        mode: normalizeMode(input.mode),
        maxBatchSize: normalizeIntegerRange(input.maxBatchSize, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.maxBatchSize, 1, 512),
        minBatchSize: normalizeIntegerRange(input.minBatchSize, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.minBatchSize, 1, 512),
        minPayloadBytes: normalizeIntegerRange(input.minPayloadBytes, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.minPayloadBytes, 0, 65_536),
        timeoutMs: normalizeIntegerRange(input.timeoutMs, DEFAULT_NATIVE_CRYPTO_WORKER_ROUTING.timeoutMs, 100, 60_000),
        logFallbacks: input.logFallbacks === true,
        telemetryEnabled: input.telemetryEnabled === true,
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

/** Settles when this caller's own signal aborts; never when there is no signal. */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return new Promise<void>(() => {});
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}

/** The standard long-task threshold: normal timer jitter stays below it, a blocked thread does not. */
const JS_LONG_TASK_MS = 50;

async function runWithDispatchLifetime<T>(fn: (signal?: AbortSignal) => Promise<T>, timeoutMs: number | null, signal?: AbortSignal): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
        const pending = fn(controller.signal);
        if (timeoutMs === null) return await pending;
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                const arm = () => {
                    const deadline = defaultNow() + timeoutMs;
                    timeout = setTimeout(() => {
                        // This bound detects a hung worker, but it runs on the thread that delivers the
                        // worker's reply. Firing late proves that thread was blocked at the deadline, so
                        // the reply may be queued behind this callback: only an on-time firing convicts.
                        if (defaultNow() - deadline > JS_LONG_TASK_MS) arm();
                        else reject(new Error('native crypto worker timed out'));
                    }, timeoutMs);
                };
                arm();
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        // Release this call's queued and in-flight work before fallback begins.
        controller.abort();
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
        const capability = await runWithDispatchLifetime(options.probe, routing.timeoutMs);
        rememberNativeCryptoWorkerCapability(options.capabilityCacheKey, capability);
        return capability;
    }

    const now = options.now ?? defaultNow;
    const startedAtMs = now();
    try {
        const capability = await runWithDispatchLifetime(options.probe, routing.timeoutMs);
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
    // Web envelope opening is a measured main-thread bottleneck, including one
    // envelope. Native bridge amortization floors do not apply.
    const webEnvelope = Platform.OS === 'web'
        && options.operation === NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1;
    if (isAbortSignalAborted(options.signal)) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }
    const declineReason: NativeCryptoWorkerRoutingDeclineReason | null = routing.mode === 'off'
        ? NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON.routingDisabled
        : !webEnvelope && options.itemCount < routing.minBatchSize
            ? NATIVE_CRYPTO_WORKER_ROUTING_DECLINE_REASON.belowMinBatchSize
            : !webEnvelope && options.payloadBytes < routing.minPayloadBytes
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
        });
    };

    let capability: NativeCryptoWorkerCapability;
    try {
        capability = await runProbe(options, routing);
    } catch (error) {
        invalidateNativeCryptoWorkerCapability(options.capabilityCacheKey);
        if (!webEnvelope) degradeNativeCryptoWorkerCapability(options.capabilityCacheKey, getNativeWorkerFailureReason(error));
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
    // The web adapter contributes envelope opening only. Other operations keep
    // their canonical reference implementation rather than dispatching an absent op.
    if (capability.supportedOperations && !capability.supportedOperations.includes(options.operation)) {
        if (routing.mode === 'require') throw new NativeCryptoWorkerUnavailableError(NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing);
        return runReference(options.referenceRun);
    }
    if (isAbortSignalAborted(options.signal)) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }

    // `timeoutMs` bounds a dispatch, not the time the app spends backgrounded. The
    // queue suspends regular dispatch deliberately, so arming the budget before it
    // resumes would degrade a perfectly healthy native worker — and leave its work
    // still queued behind the reference run that replaced it.
    const resumed = whenNativeCryptoWorkerRegularDispatchResumed();
    if (resumed) {
        await Promise.race([resumed, whenAborted(options.signal)]);
        if (isAbortSignalAborted(options.signal)) {
            return { status: 'cancelled', source: 'cancelled', items: [] };
        }
    }

    try {
        // A web envelope run drains a shared queue through its reusable Worker.
        // Its wall time includes queue wait, script loading and renderer scheduling;
        // the native bridge deadline is not a budget for that entire inventory.
        // Worker completion/error and caller cancellation own the web lifetime.
        const items = await runWithDispatchLifetime(options.nativeRun, webEnvelope ? null : routing.timeoutMs, options.signal);
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
        if (webEnvelope || isNativeWorkerUnavailableError(error)) {
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
