/** Server Socket.IO peer liveness: socket.ts pingInterval (15s) + pingTimeout (45s).
 * A silent UI dial must settle within the same existing connection-liveness window.
 */
export const SERVER_PEER_LIVENESS_WINDOW_MS = 15_000 + 45_000;

/** Streaming bodies reset this window on progress. Waiting for a response is
 * not timed: a server may still be computing, and native XHR exposes no progress.
 */
export function readServerReadInactivityTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS ?? '').trim();
    const parsed = Number(raw);
    // JavaScript timer delays are signed 32-bit milliseconds.
    return raw && Number.isFinite(parsed) && Math.trunc(parsed) > 0 && parsed <= 2_147_483_647
        ? Math.trunc(parsed) : SERVER_PEER_LIVENESS_WINDOW_MS;
}

/**
 * Upper bound for durable pending-outbox writes. Only that owner has the
 * idempotency key and retry lifecycle needed to recover an ambiguous timeout.
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
