import { ExecutionRunGetRequestSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineCapabilitiesDetect } from '@/sync/ops/capabilities';
import { readProtocolV2ExecutionRunSupport } from '@/sync/ops/actions/executionRunDetachedSupport';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import {
    sessionExecutionRunAction,
    sessionExecutionRunCancelTurn,
    sessionExecutionRunEnsure,
    sessionExecutionRunGet,
    sessionExecutionRunList,
    sessionExecutionRunStart,
    sessionExecutionRunStop,
    sessionExecutionRunWait,
} from '@/sync/ops/sessionExecutionRuns';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type UiExecutionRunActionDeps = Pick<
    ActionExecutorDeps,
    | 'executionRunCheckProtocolV2'
    | 'executionRunStart'
    | 'executionRunList'
    | 'executionRunGet'
    | 'detachedExecutionRunSend'
    | 'executionRunStop'
    | 'executionRunCancelTurn'
    | 'executionRunEnsure'
    | 'executionRunAction'
    | 'executionRunPermissionRespond'
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

function resolveExactExecutionRunMachineId(
    sessionId: string | null,
    opts: ExecutionRunOptions,
): string | null {
    const exactMachineId = normalizeId(opts?.exactMachineId);
    if (exactMachineId) return exactMachineId;

    const hostStampedMachineId = normalizeId(opts?.targetMachineId);
    if (hostStampedMachineId) return hostStampedMachineId;

    const contextualSessionId = normalizeId(opts?.originSessionId) ?? sessionId;
    const serverId = normalizeId(opts?.serverId);
    return contextualSessionId
        ? normalizeId(readMachineControlTargetForSession(
            serverId
                ? { serverId, sessionId: contextualSessionId }
                : contextualSessionId,
        )?.machineId)
        : null;
}

async function callDetachedExecutionRunRpc(
    method: string,
    request: unknown,
    opts: ExecutionRunOptions,
): Promise<unknown> {
    const machineId = resolveExactExecutionRunMachineId(null, opts);
    if (!machineId) return executionRunFailure('execution_run_target_not_selected');
    try {
        const getRequest = method === SESSION_RPC_METHODS.EXECUTION_RUN_GET
            ? ExecutionRunGetRequestSchema.safeParse(request)
            : null;
        return await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            method,
            payload: request,
            serverId: opts?.serverId,
            ...(getRequest?.success && (getRequest.data.waitForInputId || getRequest.data.waitForOutput)
                ? { operationTimeoutMs: null } : {}),
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
export function createUiExecutionRunActionDeps(scope?: ServerAccountScope): UiExecutionRunActionDeps {
    return {
        executionRunCheckProtocolV2: async (sessionId, requirement, opts) => {
            if (
                !requirement.detachedScope
                && !requirement.startAndWait
                && !requirement.exactInputResults
                && !requirement.runScopedAgentBindings
                && !requirement.secretReferenceOverlay
            ) {
                return { ok: true };
            }
            const machineId = resolveExactExecutionRunMachineId(sessionId, opts);
            if (!machineId) return executionRunFailure('execution_run_target_not_selected');
            const capability = await machineCapabilitiesDetect(
                machineId,
                { requests: [{ id: 'tool.executionRuns' }] },
                {
                    serverId: opts?.serverId,
                    ...(scope ? { accountId: scope.accountId } : {}),
                    ...(opts?.signal ? { signal: opts.signal } : {}),
                },
            );
            const executionRuns = capability.supported
                ? capability.response.results['tool.executionRuns']
                : null;
            if (!executionRuns?.ok || !readProtocolV2ExecutionRunSupport(executionRuns.data)) {
                return executionRunFailure('execution_run_protocol_unsupported');
            }
            const data = executionRuns.data as Readonly<Record<string, unknown>>;
            const features = data.features as Readonly<Record<string, unknown>>;
            if (
                (requirement.exactInputResults && features.exactInputResults !== true)
                || (requirement.runScopedAgentBindings && features.runScopedAgentBindings !== true)
                || (requirement.secretReferenceOverlay && features.secretReferenceOverlay !== true)
            ) return executionRunFailure('execution_run_protocol_unsupported');
            return { ok: true, exactMachineId: machineId };
        },
        executionRunStart: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_START, request, opts)
            : await sessionExecutionRunStart(sessionId, request, {
                serverId: opts?.serverId,
                ...(scope ? { scope } : {}),
                ...(normalizeId(opts?.exactMachineId) ?? normalizeId(opts?.targetMachineId)
                    ? { expectedMachineId: normalizeId(opts?.exactMachineId) ?? normalizeId(opts?.targetMachineId) }
                    : {}),
            }),
        executionRunList: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, request, opts)
            : await sessionExecutionRunList(sessionId, request, { serverId: opts?.serverId }),
        executionRunGet: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request, opts)
            : await sessionExecutionRunGet(sessionId, request, { serverId: opts?.serverId,
                ...(opts?.signal ? { signal: opts.signal } : {}) }),
        detachedExecutionRunSend: async (_sessionId, request, opts) =>
            await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, request, opts),
        executionRunStop: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, request, opts)
            : await sessionExecutionRunStop(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}) }),
        executionRunCancelTurn: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, request, opts)
            : await sessionExecutionRunCancelTurn(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}) }),
        executionRunEnsure: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, request, opts)
            : await sessionExecutionRunEnsure(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}) }),
        executionRunAction: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, request, opts)
            : await sessionExecutionRunAction(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}) }),
        executionRunPermissionRespond: async (request, context) => {
            const machineId = resolveExactExecutionRunMachineId(null, {
                targetMachineId: context.executionRunTargetMachineId,
                originSessionId: context.defaultSessionId,
                serverId: context.serverId,
            });
            if (!machineId) return executionRunFailure('execution_run_target_not_selected');
            return await machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
                payload: request,
                serverId: context.serverId,
                accountId: context.runtimeAccountId,
                preferScoped: true,
                signal: context.signal,
                onIssued: context.onTransportIssued,
            });
        },
        executionRunWait: async (sessionId, request, opts) => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, request, opts)
            : await sessionExecutionRunWait(sessionId, request, {
                serverId: opts?.serverId,
                ...(opts?.signal ? { signal: opts.signal } : {}),
            }),
    };
}
