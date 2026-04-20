export function normalizeExecutionRunWaitTimeoutMs(timeoutSeconds: unknown): number | null {
    if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return null;
    }

    return Math.max(1, Math.floor(timeoutSeconds * 1_000));
}
