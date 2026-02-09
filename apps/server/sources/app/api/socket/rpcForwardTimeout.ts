function parsePositiveIntOrDefault(value: string | undefined, fallback: number): number {
    if (typeof value !== 'string') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RPC_FORWARD_TIMEOUT_MS = parsePositiveIntOrDefault(process.env.HAPPIER_RPC_FORWARD_TIMEOUT_MS, 30_000);
const RPC_FORWARD_CAPABILITIES_TIMEOUT_MS = parsePositiveIntOrDefault(
    process.env.HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS,
    120_000,
);

export function resolveRpcForwardTimeoutMs(method: string): number {
    if (method.endsWith(':capabilities.invoke') || method.endsWith(':capabilities.detect') || method.endsWith(':capabilities.describe')) {
        return RPC_FORWARD_CAPABILITIES_TIMEOUT_MS;
    }
    return RPC_FORWARD_TIMEOUT_MS;
}
