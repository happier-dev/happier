import { DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

const DEFAULT_SPAWN_SESSION_RPC_TIMEOUT_MS =
    DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS + DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
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
