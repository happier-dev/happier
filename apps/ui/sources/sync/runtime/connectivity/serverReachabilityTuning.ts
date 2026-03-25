export function readServerReachabilityWaitTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_WAIT_TIMEOUT_MS ?? '').trim();
    if (!raw) return 15_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 15_000;
    return Math.max(0, Math.min(120_000, parsed));
}

export function readServerReachabilityProbeTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_PROBE_TIMEOUT_MS ?? '').trim();
    if (!raw) return 5_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 5_000;
    return Math.max(0, Math.min(30_000, parsed));
}

export function readServerReachabilityBackgroundRetryMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_BACKGROUND_RETRY_MS ?? '').trim();
    if (!raw) return 10_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 10_000;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}
