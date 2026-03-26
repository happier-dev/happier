const DEFAULT_SESSION_FILE_SYSTEM_RPC_TIMEOUT_MS = 30_000;
const MAX_SESSION_FILE_SYSTEM_RPC_TIMEOUT_MS = 10 * 60_000;

export function readSessionFileSystemRpcTimeoutMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_SYSTEM_RPC_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_SESSION_FILE_SYSTEM_RPC_TIMEOUT_MS;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SESSION_FILE_SYSTEM_RPC_TIMEOUT_MS;

    return Math.max(
        DEFAULT_SESSION_FILE_SYSTEM_RPC_TIMEOUT_MS,
        Math.min(MAX_SESSION_FILE_SYSTEM_RPC_TIMEOUT_MS, parsed),
    );
}
