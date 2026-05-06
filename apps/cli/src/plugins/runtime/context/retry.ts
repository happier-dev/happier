import type { RetryAttemptContextV1, RetryPolicyV1, RetryRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { classifyRuntimeError } from './errors';

function createAbortError(): Error {
    const error = new Error('Plugin retry operation was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    assertNotAborted(signal);
    if (ms <= 0) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(createAbortError());
        }, { once: true });
    });
}

export function createPluginRetryService(): RetryRuntimeServiceV1 {
    const service: RetryRuntimeServiceV1 = Object.freeze({
        async wrap<T>(
            operation: (context: RetryAttemptContextV1) => Promise<T>,
            policy: RetryPolicyV1,
        ): Promise<T> {
            const maxAttempts = Math.max(1, policy.maxAttempts);
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                assertNotAborted(policy.signal);
                try {
                    return await operation({
                        attempt,
                        maxAttempts,
                        signal: policy.signal,
                    });
                } catch (error) {
                    if (attempt >= maxAttempts || !classifyRuntimeError(error).retryable) {
                        throw error;
                    }
                    const baseDelayMs = Math.max(0, policy.baseDelayMs ?? 0);
                    const maxDelayMs = Math.max(baseDelayMs, policy.maxDelayMs ?? baseDelayMs);
                    await sleep(Math.min(maxDelayMs, baseDelayMs * attempt), policy.signal);
                }
            }
            throw new Error('Plugin retry operation exhausted without a result');
        },
    });
    return service;
}
