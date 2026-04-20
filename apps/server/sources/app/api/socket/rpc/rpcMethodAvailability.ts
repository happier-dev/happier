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

export function resolveRpcMethodAvailabilityGraceMs(method: string): number {
    return method.includes(":") ? SESSION_SCOPED_RPC_METHOD_AVAILABILITY_GRACE_MS : 0;
}

export function resolveRpcMethodAvailabilityPollMs(): number {
    return SESSION_SCOPED_RPC_METHOD_AVAILABILITY_POLL_MS;
}

export function resolveRpcClusterFetchTimeoutMs(method: string): number | undefined {
    return method.includes(":") ? SESSION_SCOPED_RPC_CLUSTER_FETCH_TIMEOUT_MS : undefined;
}
