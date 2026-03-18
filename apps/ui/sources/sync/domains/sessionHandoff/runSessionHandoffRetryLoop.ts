type RetryLoopOptions<TResult> = Readonly<{
    fallbackTimeoutMs: number;
    retryTimeoutMs: number;
    intervalMs: number;
    now: () => number;
    sleep: (delayMs: number) => Promise<void>;
    runAttempt: (machineRpcTimeoutMs: number) => Promise<TResult>;
    shouldRetry: (result: TResult) => boolean;
}>;

function resolveRetryBudgetedMachineRpcTimeoutMs(params: Readonly<{
    fallbackTimeoutMs: number;
    retryStartedAtMs: number;
    retryTimeoutMs: number;
    now: () => number;
}>): number {
    if (!(params.retryTimeoutMs > 0)) {
        return params.fallbackTimeoutMs;
    }
    const elapsedMs = Math.max(0, params.now() - params.retryStartedAtMs);
    const remainingMs = Math.max(1, params.retryTimeoutMs - elapsedMs);
    return Math.min(params.fallbackTimeoutMs, remainingMs);
}

export async function runSessionHandoffRetryLoop<TResult>(
    options: RetryLoopOptions<TResult>,
): Promise<TResult> {
    const startedAt = options.now();

    while (true) {
        const result = await options.runAttempt(resolveRetryBudgetedMachineRpcTimeoutMs({
            fallbackTimeoutMs: options.fallbackTimeoutMs,
            retryStartedAtMs: startedAt,
            retryTimeoutMs: options.retryTimeoutMs,
            now: options.now,
        }));
        if (!options.shouldRetry(result)) {
            return result;
        }
        if (options.now() - startedAt >= options.retryTimeoutMs) {
            return result;
        }

        await options.sleep(options.intervalMs);

        if (options.now() - startedAt >= options.retryTimeoutMs) {
            return result;
        }
    }
}
