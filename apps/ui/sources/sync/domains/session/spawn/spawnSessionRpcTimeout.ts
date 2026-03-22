const DEFAULT_SPAWN_SESSION_RPC_TIMEOUT_MS = 90_000;
const MAX_SPAWN_SESSION_RPC_TIMEOUT_MS = 10 * 60_000;

export function readSpawnSessionRpcTimeoutMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_SPAWN_SESSION_RPC_TIMEOUT_MS;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SPAWN_SESSION_RPC_TIMEOUT_MS;

    return Math.max(
        DEFAULT_SPAWN_SESSION_RPC_TIMEOUT_MS,
        Math.min(MAX_SPAWN_SESSION_RPC_TIMEOUT_MS, parsed),
    );
}

