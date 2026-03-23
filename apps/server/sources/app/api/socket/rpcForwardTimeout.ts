function parsePositiveIntOrDefault(value: string | undefined, fallback: number): number {
    if (typeof value !== 'string') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInt(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value !== 'string') return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const RPC_FORWARD_TIMEOUT_MS = parsePositiveIntOrDefault(process.env.HAPPIER_RPC_FORWARD_TIMEOUT_MS, 30_000);
const RPC_FORWARD_CAPABILITIES_TIMEOUT_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS,
    120_000,
);
const RPC_FORWARD_MAX_TIMEOUT_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS,
    300_000,
);

function resolveRpcDefaultForwardTimeoutMs(method: string): number {
    return method.endsWith(':capabilities.invoke') || method.endsWith(':capabilities.detect') || method.endsWith(':capabilities.describe')
        ? RPC_FORWARD_CAPABILITIES_TIMEOUT_MS
        : RPC_FORWARD_TIMEOUT_MS;
}

export function resolveRpcForwardTimeoutMs(method: string, requestedTimeoutMs?: unknown): number {
    const baseTimeoutMs = resolveRpcDefaultForwardTimeoutMs(method);
    const parsedRequestedTimeoutMs = parsePositiveInt(requestedTimeoutMs);
    if (parsedRequestedTimeoutMs === null) {
        return baseTimeoutMs;
    }
    return Math.min(RPC_FORWARD_MAX_TIMEOUT_MS, Math.max(baseTimeoutMs, parsedRequestedTimeoutMs));
}
