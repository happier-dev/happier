import {
    normalizeExecutionRunWaitPollIntervalMs,
    normalizeExecutionRunWaitTimeoutMs,
    waitForExecutionRunTerminal,
    type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineCapabilitiesDetect } from '@/sync/ops/capabilities';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import {
    sessionExecutionRunAction,
    sessionExecutionRunGet,
    sessionExecutionRunList,
    sessionExecutionRunSend,
    sessionExecutionRunStart,
    sessionExecutionRunStop,
} from '@/sync/ops/sessionExecutionRuns';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type UiExecutionRunActionDeps = Pick<
    ActionExecutorDeps,
    | 'executionRunCheckProtocolV2'
    | 'executionRunStart'
    | 'executionRunList'
    | 'executionRunGet'
    | 'executionRunSend'
    | 'executionRunStop'
    | 'executionRunAction'
    | 'executionRunWait'
>;

type ExecutionRunOptions = Parameters<UiExecutionRunActionDeps['executionRunStart']>[2];

function normalizeId(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function executionRunFailure(code: string, error = code): Readonly<{
    ok: false;
    errorCode: string;
    error: string;
}> {
    return { ok: false, errorCode: code, error };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function toExecutionRunWaitReadResult(value: unknown):
    | Readonly<{ ok: true; data: unknown }>
    | Readonly<{ ok: false; code: string; message?: string }> {
    const record = readRecord(value);
    if (record && (record.ok === false || typeof record.error === 'string')) {
        const code = normalizeId(record.errorCode) ?? 'execution_run_target_unavailable';
        const message = typeof record.error === 'string' ? record.error : undefined;
        return { ok: false, code, ...(message ? { message } : {}) };
    }
    return { ok: true, data: value };
}

function resolveExactExecutionRunMachineId(
    sessionId: string | null,
    opts: ExecutionRunOptions,
): string | null {
    const exactMachineId = normalizeId(opts?.exactMachineId);
    if (exactMachineId) return exactMachineId;

    const hostStampedMachineId = normalizeId(opts?.targetMachineId);
    if (hostStampedMachineId) return hostStampedMachineId;

    const contextualSessionId = normalizeId(opts?.originSessionId) ?? sessionId;
    return contextualSessionId
        ? normalizeId(readMachineControlTargetForSession(contextualSessionId)?.machineId)
        : null;
}

function readProtocolV2ExecutionRunSupport(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Readonly<Record<string, unknown>>;
    if (record.protocolVersion !== 2) return false;
    const features = record.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) return false;
    return (features as Readonly<Record<string, unknown>>).detachedScope === true
        && (features as Readonly<Record<string, unknown>>).startAndWait === true;
}

async function callDetachedExecutionRunRpc(
    method: string,
    request: unknown,
    opts: ExecutionRunOptions,
): Promise<unknown> {
    const machineId = resolveExactExecutionRunMachineId(null, opts);
    if (!machineId) return executionRunFailure('execution_run_target_not_selected');
    try {
        return await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            method,
            payload: request,
            serverId: opts?.serverId,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
    } catch (error) {
        return executionRunFailure(
            readRpcErrorCode(error) ?? 'execution_run_target_unavailable',
            error instanceof Error ? error.message : 'execution_run_target_unavailable',
        );
    }
}

/**
 * UI transport adapter for the one shared execution.run Action family. Session
 * scope stays on session RPC; detached scope has no fallback and only uses the
 * exact machine selected by V2 preflight or host-stamped invocation context.
 */
export function createUiExecutionRunActionDeps(): UiExecutionRunActionDeps {
    return {
        executionRunCheckProtocolV2: async (sessionId, requirement, opts) => {
            if (!requirement.detachedScope && !requirement.startAndWait) {
                return { ok: true };
            }
            const machineId = resolveExactExecutionRunMachineId(sessionId, opts);
            if (!machineId) return executionRunFailure('execution_run_target_not_selected');
            const capability = await machineCapabilitiesDetect(
                machineId,
                { requests: [{ id: 'tool.executionRuns' }] },
                {
                    serverId: opts?.serverId,
                    ...(opts?.signal ? { signal: opts.signal } : {}),
                },
            );
            const executionRuns = capability.supported
                ? capability.response.results['tool.executionRuns']
                : null;
            if (!executionRuns?.ok || !readProtocolV2ExecutionRunSupport(executionRuns.data)) {
                return executionRunFailure('execution_run_protocol_unsupported');
            }
            return { ok: true, exactMachineId: machineId };
        },
        executionRunStart: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_START, request, opts)
            : await sessionExecutionRunStart(sessionId, request, { serverId: opts?.serverId }),
        executionRunList: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, request, opts)
            : await sessionExecutionRunList(sessionId, request, { serverId: opts?.serverId }),
        executionRunGet: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request, opts)
            : await sessionExecutionRunGet(sessionId, request, { serverId: opts?.serverId }),
        executionRunSend: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, request, opts)
            : await sessionExecutionRunSend(sessionId, request, { serverId: opts?.serverId }),
        executionRunStop: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, request, opts)
            : await sessionExecutionRunStop(sessionId, request, { serverId: opts?.serverId }),
        executionRunAction: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, request, opts)
            : await sessionExecutionRunAction(sessionId, request, { serverId: opts?.serverId }),
        executionRunWait: async (sessionId, request, opts) => await waitForExecutionRunTerminal({
            runId: String(readRecord(request)?.runId ?? ''),
            timeoutMs: normalizeExecutionRunWaitTimeoutMs(readRecord(request)?.timeoutSeconds),
            pollIntervalMs: normalizeExecutionRunWaitPollIntervalMs(
                readRecord(request)?.pollIntervalMs,
            ),
            ...(opts?.signal ? { signal: opts.signal } : {}),
            readRun: async ({ runId }) => {
                const response = sessionId === null
                    ? await callDetachedExecutionRunRpc(
                    SESSION_RPC_METHODS.EXECUTION_RUN_GET,
                    { runId },
                    opts,
                )
                    : await sessionExecutionRunGet(sessionId, { runId }, { serverId: opts?.serverId });
                return toExecutionRunWaitReadResult(response);
            },
        }),
    };
}
