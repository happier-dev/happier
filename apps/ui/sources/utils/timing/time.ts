import { isServerFetchReadSupersededError, shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Raised by {@link withTimeout} when the wrapped operation misses its deadline.
 * Carries the deadline so callers can report the bound they enforced.
 */
export class AsyncTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`);
        this.name = 'AsyncTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Bound an operation that reaches a system boundary we do not control (native module bridges,
 * lazily fetched bundles, OS permission services). Those can stall indefinitely, and an unbounded
 * await propagates the stall into whatever owns the caller — a coalescing sync run that never
 * completes, or a screen stuck on a spinner with no recovery.
 *
 * A non-positive `timeoutMs` disables the deadline so callers can opt out without branching.
 */
export async function withTimeout<T>(
    operation: Promise<T> | (() => Promise<T>),
    timeoutMs: number,
    operationName: string,
): Promise<T> {
    const pending = typeof operation === 'function' ? operation() : operation;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return pending;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // Promise.race subscribes to `pending`, so a late rejection is delivered to an already
        // settled race rather than surfacing as an unhandled rejection.
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new AsyncTimeoutError(operationName, timeoutMs)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export function linearBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    // Linearly ramp the delay as failures increase, capped at maxDelay, then apply jitter.
    const safeMaxFailureCount = Number.isFinite(maxFailureCount) ? Math.max(maxFailureCount, 1) : 50;
    const clampedFailureCount = Math.min(Math.max(currentFailureCount, 0), safeMaxFailureCount);
    const maxDelayRet = minDelay + ((maxDelay - minDelay) / safeMaxFailureCount) * clampedFailureCount;
    const jittered = Math.random() * maxDelayRet;
    return Math.max(minDelay, Math.round(jittered));
}

export type BackoffFunc = <T>(callback: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<T>;

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** Waits out a retry delay, settling at once with the abort when the caller cancels. */
function delayUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return delay(ms).then(() => undefined);
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortReason(signal));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export function createBackoff(
    opts?: {
        onError?: (e: any, failuresCount: number) => void,
        onRetry?: (e: any, failuresCount: number, nextDelayMs: number) => void,
        shouldRetry?: (e: any, failuresCount: number) => boolean,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>, options?: Readonly<{ signal?: AbortSignal }>): Promise<T> => {
        const signal = options?.signal;
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        // Maximum number of failures we tolerate before giving up.
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 8;
        const shouldRetry = opts && opts.shouldRetry
            ? opts.shouldRetry
            : shouldRetryError;
        while (true) {
            if (signal?.aborted) throw abortReason(signal);
            try {
                return await callback();
            } catch (e) {
                // A cancelled attempt is never retried, whatever the caller's retry policy says.
                if (signal?.aborted) throw abortReason(signal);
                if (isAbortError(e)) throw e;
                if (isServerFetchReadSupersededError(e)) continue;
                currentFailureCount++;
                if (!shouldRetry(e, currentFailureCount)) {
                    throw e;
                }
                if (currentFailureCount >= maxFailureCount) {
                    throw e;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                let waitForRequest = linearBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                if (opts && opts.onRetry) {
                    opts.onRetry(e, currentFailureCount, waitForRequest);
                }
                await delayUnlessAborted(waitForRequest, signal);
            }
        }
    };
}

export let backoff = createBackoff();
export let backoffForever = createBackoff({ maxFailureCount: Number.POSITIVE_INFINITY });
