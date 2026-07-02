const DEFAULT_INITIAL_WEB_PIN_RETRY_MILESTONES_MS: readonly number[] = [16, 50, 100, 200, 400, 800];

export function resolveInitialWebPinRetryDelays(params: {
    milestonesMs: readonly unknown[] | null | undefined;
    stabilizeMaxMs: number;
    retryIntervalMs: number;
}): number[] {
    const stabilizeMaxMs = Math.max(0, Math.trunc(params.stabilizeMaxMs));
    if (stabilizeMaxMs <= 0) return [];

    const retryIntervalMs = Math.max(16, Math.trunc(params.retryIntervalMs));
    const inputMilestones = Array.isArray(params.milestonesMs) && params.milestonesMs.length > 0
        ? params.milestonesMs
        : DEFAULT_INITIAL_WEB_PIN_RETRY_MILESTONES_MS;

    const delays = new Set<number>();
    for (const rawMs of inputMilestones) {
        if (typeof rawMs !== 'number' || !Number.isFinite(rawMs)) continue;
        const ms = Math.trunc(rawMs);
        if (ms >= 0 && ms <= stabilizeMaxMs) {
            delays.add(ms);
        }
    }

    if (stabilizeMaxMs >= 1000) {
        for (let ms = 1000; ms <= stabilizeMaxMs; ms += retryIntervalMs) {
            delays.add(ms);
        }
    }

    delays.add(stabilizeMaxMs);
    return Array.from(delays).sort((left, right) => left - right);
}
