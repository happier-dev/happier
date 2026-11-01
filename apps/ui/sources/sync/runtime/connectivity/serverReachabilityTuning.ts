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

/** Recovery reads share the server peer-liveness window (socket.ts: 15s ping + 45s timeout).
 * Progressing web response bodies can take longer. Native fetch exposes no progress before
 * completion, so only callers declaring a server-bounded response may use this window there.
 */
export function readServerReadInactivityTimeoutMs(): number {
    const peerLivenessWindowMs = 15_000 + 45_000;
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS ?? '').trim();
    const parsed = Number(raw);
    // JS timers use a signed 32-bit millisecond delay; reject values that would overflow to 1ms.
    return raw && Number.isFinite(parsed) && Math.trunc(parsed) > 0 && parsed <= 2_147_483_647
        ? Math.trunc(parsed) : peerLivenessWindowMs;
}

/**
 * Upper bound for durable pending-outbox writes. The outbox owns the idempotency
 * key and retry semantics that make an ambiguous timeout recoverable; generic
 * writes must not inherit this policy.
 */
export function readServerFetchWriteTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SERVER_WRITE_TIMEOUT_MS ?? '').trim();
    if (!raw) return 120_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 120_000;
    return Math.max(0, Math.min(10 * 60_000, parsed));
}

export function readServerReachabilityBackgroundRetryMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_BACKGROUND_RETRY_MS ?? '').trim();
    if (!raw) return 10_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 10_000;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}
