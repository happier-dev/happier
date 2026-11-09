import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

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
const RPC_FORWARD_CALLER_LIFECYCLE_TIMEOUT_MS = 2_147_483_647;
const RPC_FORWARD_CALLER_LIFECYCLE_METHODS = new Set<string>([
    SESSION_RPC_METHODS.EXECUTION_RUN_START,
    SESSION_RPC_METHODS.EXECUTION_RUN_START_V2,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
    SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
    SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
    SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
    SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
]);

function isCallerLifecycleMethod(method: string): boolean {
    const scopeSeparatorIndex = method.indexOf(':');
    const normalizedMethod = scopeSeparatorIndex >= 0 ? method.slice(scopeSeparatorIndex + 1) : method;
    return RPC_FORWARD_CALLER_LIFECYCLE_METHODS.has(normalizedMethod);
}

function resolveRpcDefaultForwardTimeoutMs(method: string): number {
    if (isCallerLifecycleMethod(method)) {
        return RPC_FORWARD_CALLER_LIFECYCLE_TIMEOUT_MS;
    }
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
    if (baseTimeoutMs === RPC_FORWARD_CALLER_LIFECYCLE_TIMEOUT_MS) {
        return RPC_FORWARD_CALLER_LIFECYCLE_TIMEOUT_MS;
    }
    return Math.min(RPC_FORWARD_MAX_TIMEOUT_MS, Math.max(baseTimeoutMs, parsedRequestedTimeoutMs));
}
