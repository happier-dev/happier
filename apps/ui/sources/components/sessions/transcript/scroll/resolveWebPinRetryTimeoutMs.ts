export function resolveWebPinRetryTimeoutMs(params: Readonly<{ startedAtMs: number; nowMs: number; milestoneMs: number }>): number {
    const startedAtMs = Number.isFinite(params.startedAtMs) ? Math.trunc(params.startedAtMs) : 0;
    const nowMs = Number.isFinite(params.nowMs) ? Math.trunc(params.nowMs) : startedAtMs;
    const milestoneMs = Number.isFinite(params.milestoneMs) ? Math.max(0, Math.trunc(params.milestoneMs)) : 0;

    const elapsedMs = Math.max(0, nowMs - startedAtMs);
    return Math.max(0, milestoneMs - elapsedMs);
}
