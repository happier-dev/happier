import { RPC_METHODS } from "@happier-dev/protocol/rpc";
import { readServerConfig, SERVER_CONFIG } from '@happier-dev/protocol';
import { readStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';

const LONG_STARTUP_GRACE_SCOPED_DAEMON_RPC_METHOD_PREFIXES = [
    "daemon.externalSessions.",
    "daemon.directSessions.",
] as const;

export function resolveRpcMethodAvailabilityGraceMs(method: string): number {
    const env = readStartupHomeEnv()?.env ?? process.env;
    const scopeSeparatorIndex = method.indexOf(":");
    const normalizedMethod = scopeSeparatorIndex >= 0 ? method.slice(scopeSeparatorIndex + 1) : method;
    if (scopeSeparatorIndex >= 0 && normalizedMethod === RPC_METHODS.STOP_SESSION) {
        return readServerConfig(env, SERVER_CONFIG.HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS);
    }
    if (LONG_STARTUP_GRACE_SCOPED_DAEMON_RPC_METHOD_PREFIXES.some((prefix) => normalizedMethod.startsWith(prefix))) {
        return readServerConfig(env, SERVER_CONFIG.HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS);
    }

    if (scopeSeparatorIndex < 0) return 0;

    return readServerConfig(env, SERVER_CONFIG.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS);
}

export function resolveRpcMethodAvailabilityPollMs(): number {
    return readServerConfig(readStartupHomeEnv()?.env ?? process.env, SERVER_CONFIG.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS);
}

export function resolveRpcClusterFetchTimeoutMs(method: string): number | undefined {
    return method.includes(":") ? readServerConfig(readStartupHomeEnv()?.env ?? process.env, SERVER_CONFIG.HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS) : undefined;
}
