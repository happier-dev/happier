import { RPC_METHODS } from "@happier-dev/protocol/rpc";

function parsePositiveIntOrDefault(value: string | undefined, fallback: number): number {
    if (typeof value !== "string") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SESSION_SCOPED_RPC_METHOD_AVAILABILITY_GRACE_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS,
    750,
);

const SESSION_SCOPED_RPC_METHOD_AVAILABILITY_POLL_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS,
    25,
);

const SESSION_SCOPED_RPC_CLUSTER_FETCH_TIMEOUT_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS,
    1000,
);

const STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS,
    10_000,
);

const EXTERNAL_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS,
    15_000,
);

const LONG_STARTUP_GRACE_SCOPED_DAEMON_RPC_METHOD_PREFIXES = [
    "daemon.externalSessions.",
    "daemon.directSessions.",
] as const;

export function resolveRpcMethodAvailabilityGraceMs(method: string): number {
    const scopeSeparatorIndex = method.indexOf(":");
    const normalizedMethod = scopeSeparatorIndex >= 0 ? method.slice(scopeSeparatorIndex + 1) : method;
    if (scopeSeparatorIndex >= 0 && normalizedMethod === RPC_METHODS.STOP_SESSION) {
        return STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS;
    }
    if (LONG_STARTUP_GRACE_SCOPED_DAEMON_RPC_METHOD_PREFIXES.some((prefix) => normalizedMethod.startsWith(prefix))) {
        return EXTERNAL_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS;
    }

    if (scopeSeparatorIndex < 0) return 0;

    return SESSION_SCOPED_RPC_METHOD_AVAILABILITY_GRACE_MS;
}

export function resolveRpcMethodAvailabilityPollMs(): number {
    return SESSION_SCOPED_RPC_METHOD_AVAILABILITY_POLL_MS;
}

export function resolveRpcClusterFetchTimeoutMs(method: string): number | undefined {
    return method.includes(":") ? SESSION_SCOPED_RPC_CLUSTER_FETCH_TIMEOUT_MS : undefined;
}
