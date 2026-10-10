import { RPC_METHODS, SESSION_RPC_METHODS } from "@happier-dev/protocol/rpc";
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from "@happier-dev/protocol/actions";
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { readServerConfig, SERVER_CONFIG } from '@happier-dev/protocol';
import { readStartupHomeEnv } from '@/app/home/settings/startupHomeEnv';

function parsePositiveInt(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value !== "string") return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Socket.IO cluster acknowledgements require a finite timer. Use its maximum
// supported delay for reads whose termination is owned by their caller and
// lifecycle rather than the generic RPC request lifetime.
const RPC_FORWARD_CALLER_LIFECYCLE_TIMEOUT_MS = 2_147_483_647;
const RPC_FORWARD_CALLER_LIFECYCLE_METHODS = new Set<string>([
    // Admission owns its outcome; a late refusal must still reach its caller.
    'workflow.run.start',
    EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
    MANAGED_FINITE_WAKE_RPC_METHOD,
    RPC_METHODS.CAPABILITIES_INVOKE,
    RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE,
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION,
    SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
    SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1,
    SESSION_RPC_METHODS.EXECUTION_RUN_START,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
    SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
    SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
    SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
    SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
]);

export function isRpcForwardCallerLifecycleOwned(method: string): boolean {
    const scopeSeparatorIndex = method.indexOf(":");
    const normalizedMethod = scopeSeparatorIndex >= 0 ? method.slice(scopeSeparatorIndex + 1) : method;
    return RPC_FORWARD_CALLER_LIFECYCLE_METHODS.has(normalizedMethod);
}

export function resolveRpcForwardTimeoutMs(method: string, requestedTimeoutMs?: unknown): number {
    const parsedRequestedTimeoutMs = parsePositiveInt(requestedTimeoutMs);
    // Waiting reads and capability invocations can omit an acknowledgement deadline.
    // Explicit finite budgets retain their configured floor and ceiling.
    const preservesFiniteBudget = parsedRequestedTimeoutMs !== null
        && (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ
            || method.endsWith(`:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ}`)
            || method === RPC_METHODS.CAPABILITIES_INVOKE
            || method.endsWith(`:${RPC_METHODS.CAPABILITIES_INVOKE}`));
    const env = readStartupHomeEnv()?.env ?? process.env;
    const baseTimeoutMs = isRpcForwardCallerLifecycleOwned(method) && !preservesFiniteBudget
        ? RPC_FORWARD_CALLER_LIFECYCLE_TIMEOUT_MS
        : readServerConfig(env, method.endsWith(`:${RPC_METHODS.CAPABILITIES_INVOKE}`)
            || method.endsWith(`:${RPC_METHODS.CAPABILITIES_DETECT}`)
            || method.endsWith(`:${RPC_METHODS.CAPABILITIES_DESCRIBE}`)
            ? SERVER_CONFIG.HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS
            : SERVER_CONFIG.HAPPIER_RPC_FORWARD_TIMEOUT_MS);
    if (parsedRequestedTimeoutMs === null) {
        return baseTimeoutMs;
    }
    if (baseTimeoutMs === RPC_FORWARD_CALLER_LIFECYCLE_TIMEOUT_MS) {
        return baseTimeoutMs;
    }
    return Math.min(readServerConfig(env, SERVER_CONFIG.HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS), Math.max(baseTimeoutMs, parsedRequestedTimeoutMs));
}
