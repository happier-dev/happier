const DEFAULT_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS = 1_000;
const MIN_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS = 250;
const MAX_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS = 60_000;

export function normalizeExecutionRunWaitTimeoutMs(timeoutSeconds: unknown): number | null {
    if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return null;
    }

    return Math.max(1, Math.floor(timeoutSeconds * 1_000));
}

export function normalizeExecutionRunWaitPollIntervalMs(
    pollIntervalMs: unknown,
    fallbackMs = DEFAULT_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS,
): number {
    const parsed =
        typeof pollIntervalMs === 'number'
            ? pollIntervalMs
            : Number.parseInt(String(pollIntervalMs ?? '').trim(), 10);
    const fallback =
        Number.isFinite(fallbackMs) && fallbackMs > 0
            ? Math.trunc(fallbackMs)
            : DEFAULT_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS;
    const candidate = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
    return Math.max(
        MIN_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS,
        Math.min(MAX_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS, candidate),
    );
}
