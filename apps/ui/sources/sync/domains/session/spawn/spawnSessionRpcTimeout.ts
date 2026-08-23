const DEFAULT_SPAWN_SESSION_RPC_TIMEOUT_MS = 5 * 60_000;
const MAX_SPAWN_SESSION_RPC_TIMEOUT_MS = 10 * 60_000;

// Fork blocks on the provider-side fork (vendor thread/fork RPC) PLUS an
// accept-then-async spawn resolution. The RPC acknowledgement
// budget must exceed that total, otherwise a slow-but-healthy fork triggers
// timeout-driven transport retries.
const DEFAULT_FORK_SESSION_RPC_TIMEOUT_MS = 8 * 60_000;

function readBoundedTimeoutMsFromEnv(raw: string, fallback: number): number {
    const trimmed = raw.trim();
    if (!trimmed) return fallback;

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return fallback;

    return Math.max(fallback, Math.min(MAX_SPAWN_SESSION_RPC_TIMEOUT_MS, parsed));
}

export function readSpawnSessionRpcTimeoutMsFromEnv(): number {
    return readBoundedTimeoutMsFromEnv(
        String(process.env.EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS ?? ''),
        DEFAULT_SPAWN_SESSION_RPC_TIMEOUT_MS,
    );
}

export function readForkSessionRpcTimeoutMsFromEnv(): number {
    return readBoundedTimeoutMsFromEnv(
        String(process.env.EXPO_PUBLIC_HAPPIER_FORK_SESSION_RPC_TIMEOUT_MS ?? ''),
        DEFAULT_FORK_SESSION_RPC_TIMEOUT_MS,
    );
}
