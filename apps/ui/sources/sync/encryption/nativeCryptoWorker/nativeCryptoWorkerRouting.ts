import {
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    NativeCryptoWorkerUnavailableError,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerCapability,
    type NativeCryptoWorkerOperation,
} from './types';
import { recordNativeCryptoWorkerStaleScopeDropForResume } from './nativeCryptoWorkerQueue';

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
    signal?: AbortSignal;
    probe: () => Promise<NativeCryptoWorkerCapability>;
    nativeRun: () => Promise<readonly T[]>;
    referenceRun: () => Promise<readonly T[]>;
    isScopeCurrent?: () => boolean;
}>;

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

export async function runNativeCryptoWorkerBatch<T>(
    options: RunNativeCryptoWorkerBatchOptions<T>,
): Promise<NativeCryptoWorkerBatchResult<T>> {
    const routing = normalizeNativeCryptoWorkerRouting(options.routing);
    if (isAbortSignalAborted(options.signal)) {
        return { status: 'cancelled', source: 'cancelled', items: [] };
    }
    if (
        routing.mode === 'off'
        || options.itemCount < routing.minBatchSize
        || options.payloadBytes < routing.minPayloadBytes
    ) {
        return runReference(options.referenceRun);
    }

    const capability = await options.probe();
    if (!capability.available) {
        if (routing.mode === 'require') {
            throw new NativeCryptoWorkerUnavailableError(capability.failureReason);
        }
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
        if (routing.mode === 'require') {
            throw error;
        }
        return runReference(options.referenceRun);
    }
}

export const NATIVE_CRYPTO_WORKER_UNAVAILABLE_CAPABILITY: NativeCryptoWorkerCapability = {
    available: false,
    failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.missing,
};
