export type ProbedResourceRetryableCacheEntry = Readonly<{
    kind: 'error' | 'success';
    expiresAt: number;
}>;

export function scheduleProbedResourceRetryAfterExpiry(
    entry: ProbedResourceRetryableCacheEntry | null,
    nowMs: number,
    onRetry: () => void,
): ReturnType<typeof setTimeout> | null {
    if (!entry || entry.kind !== 'error') {
        return null;
    }
    if (!(nowMs >= 0 && nowMs < entry.expiresAt)) {
        return null;
    }
    const delayMs = Math.max(0, entry.expiresAt - nowMs);
    return setTimeout(onRetry, delayMs);
}

