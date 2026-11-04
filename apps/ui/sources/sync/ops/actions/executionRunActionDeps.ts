import { ExecutionRunGetRequestSchema, withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { machineCapabilitiesDetect } from '@/sync/ops/capabilities';
import { readExecutionRunProtocolV2Support } from '@happier-dev/protocol/execution/runs/protocolSupport';
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
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { createUiAccountActionTransport } from './accountActionTransport';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type UiExecutionRunActionDeps = Required<Pick<
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
>>;

type ExecutionRunOptions = Parameters<NonNullable<UiExecutionRunActionDeps['executionRunStart']>>[2];

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
            ...(opts?.onTransportIssued ? { onIssued: opts.onTransportIssued } : {}),
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
export function createUiExecutionRunActionDeps(scope?: ServerAccountScope, account?: LazyActionAccountContext): UiExecutionRunActionDeps {
    const withRunRequestSignal = <T>(opts: ExecutionRunOptions, run: (opts: NonNullable<ExecutionRunOptions>) => Promise<T>) =>
        withActionAccountRequestSignal(account, opts?.signal, signal => run({ ...opts, signal }));
    const requesterAction = account ? createUiAccountActionTransport({ account, resolveFallbackMachineId: () => null,
        transport: async request => await executeOriginalAccountMachineAction({ account, actionId: 'execution.run.start',
            machineId: request.machineId, machineTarget: request.target, input: request.payload,
            requestId: request.requestId, authority: request.invocation.authority, invocation: request.invocation,
            ...(request.onTransportIssued ? { onTransportIssued: request.onTransportIssued } : {}),
            ...(request.signal ? { signal: request.signal } : {}) }),
    }) : null;
    return {
        executionRunCheckProtocolV2: (sessionId, requirement, options) => withRunRequestSignal(options, async opts => {
            if (
                !requirement.detachedScope
                && !requirement.startAndWait
                && !requirement.exactInputResults
                && !requirement.runScopedAgentBindings
                && !requirement.secretReferenceOverlay
            ) {
                return { ok: true as const };
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
            const support = readExecutionRunProtocolV2Support(capability, requirement, opts?.signal);
            if (!support.ok) return support;
            return { ok: true as const, exactMachineId: machineId };
        }),
        executionRunStart: (sessionId, request, options) => withRunRequestSignal(options, async opts => {
            if (sessionId === null) {
                const refuse = (code: string) => ({ ...executionRunFailure(code),
                    details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') });
                const machineId = resolveExactExecutionRunMachineId(null, opts);
                if (!machineId) return refuse('execution_run_target_not_selected');
                if (!requesterAction || !account) return refuse('admission_unavailable');
                if (opts?.serverId && !areServerProfileIdentifiersEquivalent(opts.serverId, account.serverId)
                    || opts?.runtimeAccountId && opts.runtimeAccountId !== account.accountId) return refuse('content_unavailable');
                if (opts?.externalActionTarget && (opts.externalActionTarget.kind !== 'machine'
                    || opts.externalActionTarget.machineId !== machineId)) return refuse('target_not_local');
                // Launch provenance belongs to the receiving host. The original
                // Action ingress re-admits the public input for this exact target.
                const { launchOrigin: _launchOrigin, ...input } = request;
                let issued = false;
                const result = await requesterAction({ actionId: 'execution.run.start', input: { ...input, sessionId: null },
                    context: { serverId: account.serverId, runtimeAccountId: account.accountId,
                        surface: opts?.surface, authority: opts?.authority, actionCaller: opts?.actionCaller,
                        actionRequestId: opts?.actionRequestId, externalActionTarget: opts?.externalActionTarget ?? { kind: 'machine', machineId },
                        onTransportIssued: () => { issued = true; opts?.onTransportIssued?.(); },
                        ...(opts?.externalActionCredential ? { externalActionCredential: opts.externalActionCredential } : {}),
                        ...(opts?.effectiveCallerPermissionMode !== undefined ? { callerPermissionMode: opts.effectiveCallerPermissionMode } : {}),
                        ...(opts?.callerInputConstraints ? { callerInputConstraints: opts.callerInputConstraints } : {}),
                        ...(opts?.workspaceWrites ? { workspaceWrites: opts.workspaceWrites } : {}),
                        ...(opts?.originSessionId ? { defaultSessionId: opts.originSessionId } : {}),
                        ...(opts?.signal ? { signal: opts.signal } : {}),
                    } });
                const failure = !issued ? ActionExecuteFailureSchema.safeParse(result) : null;
                if (failure?.success) return { ...failure.data,
                    details: withExecutionRunStartFailureDetails(failure.data.details, 'noRunCreated') };
                return result && typeof result === 'object' && 'ok' in result && result.ok === true && 'result' in result
                    ? result.result : result;
            }
            return await sessionExecutionRunStart(sessionId, request, {
                serverId: opts?.serverId,
                ...(scope ? { scope } : {}),
                ...(opts?.signal ? { signal: opts.signal } : {}),
                ...(opts?.onTransportIssued ? { onIssued: opts.onTransportIssued } : {}),
                ...(normalizeId(opts?.exactMachineId) ?? normalizeId(opts?.targetMachineId)
                    ? { expectedMachineId: normalizeId(opts?.exactMachineId) ?? normalizeId(opts?.targetMachineId) }
                    : {}),
            });
        }),
        executionRunList: (sessionId, request, options) => withRunRequestSignal(options, async opts => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, request, opts)
            : await sessionExecutionRunList(sessionId, request, { serverId: opts?.serverId,
                ...(opts?.signal ? { signal: opts.signal } : {}) })),
        executionRunGet: (sessionId, request, options) => withRunRequestSignal(options, async opts => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_GET, request, opts)
            : await sessionExecutionRunGet(sessionId, request, { serverId: opts?.serverId,
                ...(opts?.signal ? { signal: opts.signal } : {}) })),
        detachedExecutionRunSend: (_sessionId, request, options) => withRunRequestSignal(options, async opts =>
            await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, request, opts)),
        executionRunStop: (sessionId, request, options) => withRunRequestSignal(options, async opts => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_STOP, request, opts)
            : await sessionExecutionRunStop(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}),
                ...(opts?.onTransportIssued ? { onIssued: opts.onTransportIssued } : {}),
                ...(opts?.signal ? { signal: opts.signal } : {}) })),
        executionRunCancelTurn: (sessionId, request, options) => withRunRequestSignal(options, async opts => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, request, opts)
            : await sessionExecutionRunCancelTurn(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}),
                ...(opts?.signal ? { signal: opts.signal } : {}) })),
        executionRunEnsure: (sessionId, request, options) => withRunRequestSignal(options, async opts => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, request, opts)
            : await sessionExecutionRunEnsure(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}),
                ...(opts?.signal ? { signal: opts.signal } : {}) })),
        executionRunAction: (sessionId, request, options) => withRunRequestSignal(options, async opts => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, request, opts)
            : await sessionExecutionRunAction(sessionId, request, { serverId: opts?.serverId, ...(scope ? { scope } : {}),
                ...(opts?.signal ? { signal: opts.signal } : {}) })),
        executionRunPermissionRespond: async (request, context) => {
            const machineId = resolveExactExecutionRunMachineId(null, {
                targetMachineId: context.executionRunTargetMachineId,
                originSessionId: context.defaultSessionId,
                serverId: context.serverId,
            });
            if (!machineId) return executionRunFailure('execution_run_target_not_selected');
            return await withActionAccountRequestSignal(account, context.signal, signal => machineRpcWithServerScope({
                machineId,
                method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
                payload: request,
                serverId: context.serverId,
                accountId: context.runtimeAccountId,
                preferScoped: true,
                signal,
                onIssued: context.onTransportIssued,
            }));
        },
        executionRunWait: (sessionId, request, options) => withRunRequestSignal(options, async opts => sessionId === null
            ? await callDetachedExecutionRunRpc(SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, request, opts)
            : await sessionExecutionRunWait(sessionId, request, {
                serverId: opts?.serverId,
                ...(opts?.signal ? { signal: opts.signal } : {}),
            })),
    };
}
