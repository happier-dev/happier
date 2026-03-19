const DEFAULT_PROVIDER_AUTH_REFRESH_DELAYS_MS = [0, 750, 2_500] as const;

export function scheduleProviderAuthenticationRefreshes(params: Readonly<{
    refresh: () => void;
    delaysMs?: readonly number[];
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
}>): () => void {
    const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    for (const rawDelayMs of (params.delaysMs ?? DEFAULT_PROVIDER_AUTH_REFRESH_DELAYS_MS)) {
        const delayMs = Number.isFinite(rawDelayMs) ? Math.max(0, Math.trunc(rawDelayMs)) : 0;
        if (delayMs === 0) {
            params.refresh();
            continue;
        }

        timers.push(setTimeoutFn(() => {
            params.refresh();
        }, delayMs));
    }

    return () => {
        for (const timer of timers) {
            clearTimeoutFn(timer);
        }
    };
}
