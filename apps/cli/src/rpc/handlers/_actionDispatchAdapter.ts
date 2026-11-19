import { projectExternalActionWorkflowSessionLeafContextV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import type { RpcLocalActionContext, RpcHandlerContext } from '@/api/rpc/types';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncSourceContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isSessionStopChildV1 } from '@happier-dev/protocol/actions/sessionSections';
import type { VerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { ActionOperationCancellation } from '@/daemon/actionOperations/actionOperationTypes';
import type { ExternalSessionOperationAccountAdmission } from '@/session/actions/externalSessions/operationRecordStore';
import { admitExternalActionRequesterInvocationAttributionV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutor>[0];

type HostRequesterContext = Pick<RpcHandlerContext, 'authorization' | 'machineAdmission' | 'verifyMachineAdmissionCurrent'
    | 'requesterApprovalDecision'
    | 'requesterSessionBootstrap' | 'sessionActionOrigin' | 'callerInputAuthorization' | 'callerInputConstraints'
    | 'workspaceSyncSourceRouting' | 'workspaceSyncTargetRouting' | 'workspaceSyncSourceWriterTargetRouting' | 'workspaceSyncSeedRouting'
    | 'originalActionEnvelope' | 'workspaceSyncSourceExecution' | 'deadlineAtMs' | 'requestStartedAtMs' | 'reviewedChildActionContext'>;

export type RpcActionExecutorContext = ActionExecutorContext & HostRequesterContext & Readonly<{
    authenticatedLocalRootCustody?: RpcLocalActionContext['authenticatedLocalRootCustody'];
    verifiedExternalActionRequester?: VerifiedExternalActionRequester;
    signal?: AbortSignal;
    operationProgress?: NonNullable<RpcLocalActionContext['operationProgress']>;
    operationOwnerUpdate?: NonNullable<RpcLocalActionContext['operationOwnerUpdate']>;
    operationCancellation?: ActionOperationCancellation;
    requesterWorkAttributionV1?: RpcLocalActionContext['requesterWorkAttributionV1'];
    operationReview?: RpcLocalActionContext['operationReview'];
    /** In-process external-operation authority; not accepted from RPC input. */
    externalSessionOperationAdmission?: ExternalSessionOperationAccountAdmission;
}>;

/** Transport projection of an already admitted Action context; it creates no authority. */
export function projectWorkspaceSyncPhysicalContextFromActionContext(context: RpcActionExecutorContext) {
    if (!context.machineAdmission) throw Object.assign(new Error('Workspace child authority is unavailable'), { code: 'peer_unavailable' });
    return WorkspaceSyncSourceContextV1Schema.parse({
        machineAdmission: context.machineAdmission,
        callerAuthority: context.authority ?? 'account_automation',
        ...(context.sessionActionOrigin ? { sessionActionOrigin: context.sessionActionOrigin } : {}),
        ...(context.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
        ...(context.callerPermissionMode !== undefined ? { callerPermissionMode: context.callerPermissionMode } : {}),
        ...(context.causalPermissionAuthority !== undefined ? { causalPermissionAuthority: context.causalPermissionAuthority } : {}),
        ...(context.workspaceWrites ? { workspaceWrites: context.workspaceWrites } : {}),
    });
}

export type RpcActionExecutor<TActionId extends ActionId = ActionId> = Readonly<{
    execute: (
        actionId: TActionId,
        input: unknown,
        context?: RpcActionExecutorContext,
    ) => Promise<ActionExecuteResult>;
}>;

export type RpcActionDispatchRequest<TActionId extends ActionId = ActionId> = HostRequesterContext & Readonly<{
    actionId: TActionId;
    input: unknown;
    defaultSessionId?: string | null;
    serverId?: string | null;
    externalActionTarget?: ActionExecutorContext['externalActionTarget'];
    signal?: AbortSignal;
    localActionContext?: RpcLocalActionContext;
    callerAuthority?: ActionExecutorContext['authority'];
    /** Validated targeted-Session envelope after Home Account-owner admission. */
    transportPluginCaller?: Extract<NonNullable<ActionExecutorContext['actionCaller']>, { kind: 'plugin' }>;
    sessionActionOrigin?: SessionActionRpcOriginV1;
    rpcSessionAuthorization?: ActionExecutorContext['rpcSessionAuthorization'];
    runtimeAccountId?: ActionExecutorContext['runtimeAccountId'];
    externalActionExecutionAuthorization?: ActionExecutorContext['externalActionExecutionAuthorization'];
    executor?: RpcActionExecutor<TActionId>;
    executorParams?: CliActionExecutorParams;
}>;

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function buildActionExecutorContextForRpc(
    params: Pick<RpcActionDispatchRequest, 'defaultSessionId' | 'serverId' | 'externalActionTarget' | 'signal' | 'localActionContext' | 'callerAuthority' | 'transportPluginCaller' | 'sessionActionOrigin' | 'rpcSessionAuthorization' | 'runtimeAccountId' | 'externalActionExecutionAuthorization' | keyof HostRequesterContext>
        & Partial<Pick<RpcActionDispatchRequest, 'actionId'>>,
): RpcActionExecutorContext {
    const defaultSessionId = normalizeOptionalString(params.defaultSessionId);
    const serverId = normalizeOptionalString(params.serverId);
    const localActionContext = params.localActionContext;
    const surface = localActionContext?.surface ?? 'rpc';
    const hasLocalCallerPermissionMode = Boolean(
        localActionContext
        && Object.prototype.hasOwnProperty.call(localActionContext, 'callerPermissionMode'),
    );
    const hasLocalCausalPermissionAuthority = Boolean(
        localActionContext
        && Object.prototype.hasOwnProperty.call(localActionContext, 'causalPermissionAuthority'),
    );
    const requesterAuthorization = params.callerInputAuthorization?.requesterAccountProjection
        ? params.callerInputAuthorization : undefined;
    const externalActionExecutionAuthorization = params.externalActionExecutionAuthorization
        ?? localActionContext?.externalActionExecutionAuthorization ?? requesterAuthorization;
    const runtimeAccountId = params.runtimeAccountId ?? externalActionExecutionAuthorization?.binding.accountId
        ?? localActionContext?.runtimeAccountId;
    const requesterInvocation = requesterAuthorization && !params.sessionActionOrigin
        && !requesterAuthorization.binding.workflowActionOrigin
        ? readRequesterAccountActionContext(requesterAuthorization)?.invocation : undefined;
    const privateInvocation = readRequesterAccountActionContext(requesterAuthorization)?.invocation;
    const invocationAttribution = admitExternalActionRequesterInvocationAttributionV1(
        privateInvocation, requesterAuthorization?.binding, params.transportPluginCaller ?? privateInvocation?.caller);
    if (!invocationAttribution.ok) {
        throw new RpcError('forbidden', RPC_ERROR_CODES.FORBIDDEN);
    }
    const workflowAuthorization = params.callerInputAuthorization;
    const workflowBinding = workflowAuthorization?.binding;
    const workflowOrigin = workflowBinding?.workflowActionOrigin;
    const workflowWitness = workflowOrigin?.sessionAuthority;
    const originalHandoffAuthorization = (() => {
        const authorization = params.callerInputAuthorization;
        const binding = authorization?.binding;
        const admission = params.machineAdmission;
        const handoff = binding?.handoffAdmission;
        // Only verified receiving-host context can carry the original SOURCE
        // Root. A requester box is not an Action correlation or authority owner.
        if (params.actionId !== 'session.handoff' || !authorization || !binding || !admission || !handoff
            || !params.verifyMachineAdmissionCurrent || params.sessionActionOrigin || binding.sessionActionOrigin
            || binding.actionId !== 'session.handoff' || binding.handoffContinuation
            || binding.machineId !== admission.machineId || binding.installationId !== admission.installationId
            || binding.accountId !== admission.actorAccountId || binding.custodianAccountId !== admission.custodianAccountId
            || binding.target.kind !== 'machine' || binding.target.machineId !== admission.machineId
            || handoff.sourceMachineId !== admission.machineId || handoff.sourceInstallationId !== admission.installationId
            || defaultSessionId && defaultSessionId !== handoff.sessionId) return undefined;
        return authorization;
    })();
    const effectiveAuthorization = (workflowOrigin ? workflowAuthorization : originalHandoffAuthorization)
        ?? externalActionExecutionAuthorization;
    // The registrar can forward the same verified requester object as the explicit authorization too.
    const externalActionContinuation = effectiveAuthorization !== undefined
        && (effectiveAuthorization === requesterAuthorization
            || effectiveAuthorization === localActionContext?.externalActionExecutionAuthorization);
    const workspaceSourceContext = params.workspaceSyncSourceWriterTargetRouting?.source.sourceContext
        ?? params.workspaceSyncSeedRouting?.sourceWriterTarget.source.sourceContext;
    const movePacket = params.workspaceSyncSourceExecution;
    const admittedStopChild = requesterAuthorization && movePacket && params.actionId === 'session.stop'
        && params.verifyMachineAdmissionCurrent && params.machineAdmission
        && params.machineAdmission.actorAccountId === requesterAuthorization.binding.accountId
        && movePacket.method === `${params.machineAdmission.machineId}:${RPC_METHODS.STOP_SESSION}`
        && movePacket.externalActionExecution.authorization.token === requesterAuthorization.token
        && isSessionStopChildV1({ rootActionId: requesterAuthorization.binding.actionId,
            effectActionId: movePacket.externalActionExecution.effectActionId, method: RPC_METHODS.STOP_SESSION,
            target: movePacket.externalActionExecution.target, params: movePacket.params });
    const admittedSecondOpinionChild = (requesterAuthorization?.binding.actionId === 'discussion.second_opinion.start'
        && movePacket?.method === `${params.machineAdmission?.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`)
        && movePacket?.originalActionEnvelope && params.verifyMachineAdmissionCurrent && params.machineAdmission
        && params.machineAdmission.actorAccountId === requesterAuthorization.binding.accountId
        && movePacket.externalActionExecution.authorization.token === requesterAuthorization.token
        && params.actionId === 'session.spawn_new';

    return {
        ...params.reviewedChildActionContext,
        ...(params.authorization ? { authorization: params.authorization } : {}),
        ...(params.requesterApprovalDecision ? { requesterApprovalDecision: params.requesterApprovalDecision } : {}),
        ...(params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs }),
        ...(params.requestStartedAtMs === undefined ? {} : { requestStartedAtMs: params.requestStartedAtMs }),
        ...(params.machineAdmission ? { machineAdmission: params.machineAdmission } : {}),
        ...(params.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: params.verifyMachineAdmissionCurrent } : {}),
        ...(params.requesterSessionBootstrap ? { requesterSessionBootstrap: params.requesterSessionBootstrap } : {}),
        ...(params.sessionActionOrigin ? { sessionActionOrigin: params.sessionActionOrigin } : {}),
        ...(params.callerInputAuthorization ? { callerInputAuthorization: params.callerInputAuthorization } : {}),
        ...(params.callerInputConstraints ? { callerInputConstraints: params.callerInputConstraints } : {}),
        ...(params.workspaceSyncSourceRouting ? { workspaceSyncSourceRouting: params.workspaceSyncSourceRouting } : {}),
        ...(params.workspaceSyncTargetRouting ? { workspaceSyncTargetRouting: params.workspaceSyncTargetRouting } : {}),
        ...(params.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: params.workspaceSyncSourceExecution } : {}),
        ...(params.originalActionEnvelope ? { originalActionEnvelope: params.originalActionEnvelope } : {}),
        ...(params.workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting: params.workspaceSyncSourceWriterTargetRouting } : {}),
        ...(params.workspaceSyncSeedRouting ? { workspaceSyncSeedRouting: params.workspaceSyncSeedRouting } : {}),
        ...(defaultSessionId ? { defaultSessionId } : {}),
        ...(serverId ? { serverId } : {}),
        ...(params.externalActionTarget ? { externalActionTarget: params.externalActionTarget } : {}),
        ...(params.rpcSessionAuthorization ? { rpcSessionAuthorization: params.rpcSessionAuthorization } : {}),
        ...(runtimeAccountId ? { runtimeAccountId } : {}),
        ...(externalActionExecutionAuthorization
            ? { externalActionExecutionAuthorization,
                serverIdentityId: externalActionExecutionAuthorization.binding.serverIdentityId } : {}),
        ...(localActionContext?.presentUserConfirmation
            ? { presentUserConfirmation: localActionContext.presentUserConfirmation } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(localActionContext?.authenticatedLocalRootCustody
            ? { authenticatedLocalRootCustody: localActionContext.authenticatedLocalRootCustody } : {}),
        ...(localActionContext?.agentStartContext ? { agentStartContext: localActionContext.agentStartContext } : {}),
        ...(localActionContext?.agentStartWorkDepth !== undefined ? { agentStartWorkDepth: localActionContext.agentStartWorkDepth } : {}),
        ...(localActionContext?.agentStartWorkspaceWrites !== undefined ? { agentStartWorkspaceWrites: localActionContext.agentStartWorkspaceWrites } : {}),
        ...(localActionContext?.sessionAgentSpawnPolicyV1 !== undefined ? { sessionAgentSpawnPolicyV1: localActionContext.sessionAgentSpawnPolicyV1 } : {}),
        ...(localActionContext?.operationProgress
            ? { operationProgress: localActionContext.operationProgress }
            : {}),
        ...(localActionContext?.operationOwnerUpdate
            ? { operationOwnerUpdate: localActionContext.operationOwnerUpdate }
            : {}),
        ...(localActionContext?.operationAcceptance
            ? { operationAcceptance: localActionContext.operationAcceptance }
            : {}),
        ...(localActionContext?.runActionOperation
            ? { runActionOperation: localActionContext.runActionOperation }
            : {}),
        ...(localActionContext?.operationCancellation
            ? { operationCancellation: localActionContext.operationCancellation }
            : {}),
        ...(localActionContext?.operationReview
            ? { operationReview: localActionContext.operationReview }
            : {}),
        ...(localActionContext?.requesterWorkAttributionV1
            ? { requesterWorkAttributionV1: localActionContext.requesterWorkAttributionV1 }
            : {}),
        ...(localActionContext?.executionRunPermissionRequestStore === undefined
            ? {}
            : { executionRunPermissionRequestStore: localActionContext.executionRunPermissionRequestStore }),
        ...(localActionContext?.executionRunWorkflowObservationSink === undefined
            ? {}
            : { executionRunWorkflowObservationSink: localActionContext.executionRunWorkflowObservationSink }),
        ...(localActionContext?.executionRunWorkflowRunId
            ? { executionRunWorkflowRunId: localActionContext.executionRunWorkflowRunId }
            : {}),
        ...(localActionContext?.executionRunWorkflowScope
            ? { executionRunWorkflowScope: localActionContext.executionRunWorkflowScope }
            : {}),
        ...(localActionContext?.executionRunTargetMachineId
            ? { executionRunTargetMachineId: localActionContext.executionRunTargetMachineId }
            : {}),
        surface,
        ...(admittedSecondOpinionChild && params.actionId ? { bypassApprovals: true,
            presentUserConfirmation: { actionId: params.actionId } } : {}),
        authority: params.callerAuthority ?? localActionContext?.authority ?? 'account_automation',
        // The installed TARGET hop retains the Home-admitted SOURCE ceilings.
        // Explicit local and invocation-origin ceilings below still take precedence.
        ...(workspaceSourceContext?.callerPermissionMode !== undefined
            ? { callerPermissionMode: workspaceSourceContext.callerPermissionMode }
            : {}),
        ...(workspaceSourceContext?.causalPermissionAuthority !== undefined
            ? { causalPermissionAuthority: workspaceSourceContext.causalPermissionAuthority }
            : {}),
        ...(workspaceSourceContext?.workspaceWrites
            ? { workspaceWrites: workspaceSourceContext.workspaceWrites }
            : {}),
        ...(localActionContext?.actionRequestId
            ? { actionRequestId: localActionContext.actionRequestId }
            : {}),
        ...(localActionContext?.actionCaller
            ? { actionCaller: localActionContext.actionCaller }
            : {}),
        ...(params.transportPluginCaller ? {
            actionCaller: params.transportPluginCaller,
            authority: 'account_automation' as const,
        } : {}),
        ...(hasLocalCallerPermissionMode
            ? { callerPermissionMode: localActionContext?.callerPermissionMode ?? null }
            : {}),
        ...(hasLocalCausalPermissionAuthority
            ? { causalPermissionAuthority: localActionContext?.causalPermissionAuthority ?? null }
            : {}),
        ...(originalHandoffAuthorization ? {
            actionRequestId: originalHandoffAuthorization.binding.requestId,
            externalActionExecutionAuthorization: originalHandoffAuthorization,
            externalActionTarget: originalHandoffAuthorization.binding.target,
        } : {}),
        ...(requesterAuthorization ? {
            actionRequestId: requesterAuthorization.binding.requestId,
            serverId: requesterAuthorization.requesterAccountProjection!.serverId,
            serverIdentityId: requesterAuthorization.binding.serverIdentityId,
            externalActionTarget: admittedStopChild && movePacket
                ? movePacket.externalActionExecution.target : requesterAuthorization.binding.target,
        } : {}),
        ...(requesterAuthorization && !params.sessionActionOrigin ? {
            surface: 'authentication' in requesterAuthorization.binding ? 'ui' as const : 'api' as const,
            ...('authentication' in requesterAuthorization.binding
                && !requesterAuthorization.binding.sessionActionOrigin && !requesterAuthorization.binding.workflowActionOrigin
                ? { defaultSessionMachineId: requesterAuthorization.binding.machineId } : {}),
            ...('grant' in requesterAuthorization.binding ? { externalActionCredential: {
                accountId: requesterAuthorization.binding.accountId,
                principalId: requesterAuthorization.binding.principalId,
                credentialId: requesterAuthorization.binding.credentialId,
                grant: requesterAuthorization.binding.grant,
            } } : {}),
        } : {}),
        ...(requesterInvocation ? {
            ...(invocationAttribution.actionRequestAttributionV1 ? { actionRequestAttributionV1: invocationAttribution.actionRequestAttributionV1 } : {}),
            surface: requesterInvocation.surface,
            authority: requesterInvocation.authority === 'account_automation' ? 'account_automation' as const
                : params.callerAuthority ?? 'account_automation',
            actionCaller: requesterInvocation.caller,
            ...(requesterInvocation.presentUserConfirmation
                ? { presentUserConfirmation: requesterInvocation.presentUserConfirmation } : {}),
            ...(requesterInvocation.callerPermissionMode !== undefined
                ? { callerPermissionMode: requesterInvocation.callerPermissionMode } : {}),
            ...(requesterInvocation.workspaceWrites ? { workspaceWrites: requesterInvocation.workspaceWrites } : {}),
            ...(requesterInvocation.defaultSessionId ? { defaultSessionId: requesterInvocation.defaultSessionId } : {}),
        } : {}),
        ...(params.sessionActionOrigin ? {
            // Invocation origin is transport authority, not the Session being mutated.
            surface: 'agent' as const,
            authority: 'account_automation' as const,
            defaultSessionId: params.sessionActionOrigin.caller.sessionId,
            ...(params.callerInputAuthorization?.binding.sessionActionSource
                ? { defaultSessionMachineId: params.callerInputAuthorization.binding.sessionActionSource.machineId } : {}),
            actionCaller: params.sessionActionOrigin.caller,
            actionRequestId: params.sessionActionOrigin.requestId,
            callerPermissionMode: params.sessionActionOrigin.callerPermissionMode,
            causalPermissionAuthority: params.sessionActionOrigin.causalPermissionAuthority ?? null,
            ...(params.sessionActionOrigin.actionRequestAttributionV1
                ? { actionRequestAttributionV1: params.sessionActionOrigin.actionRequestAttributionV1 } : {}),
            sessionInputSource: { sourceSessionId: params.sessionActionOrigin.caller.sessionId,
                sourceTurnId: params.sessionActionOrigin.sourceTurnId,
                ...(params.sessionActionOrigin.sourceInputId ? { sourceInputId: params.sessionActionOrigin.sourceInputId } : {}),
                via: 'action' as const },
            ...(params.sessionActionOrigin.workspaceWrites ? { workspaceWrites: params.sessionActionOrigin.workspaceWrites } : {}),
        } : {}),
        ...(workflowAuthorization ? projectExternalActionWorkflowSessionLeafContextV1(workflowAuthorization) : {}),
        // Machine-only leaves retain their verified Run identity without a
        // Session witness; Session authority remains in the witness branch.
        ...(workflowAuthorization && workflowBinding && workflowOrigin ? {
            surface: 'agent' as const,
            authority: 'account_automation' as const,
            actionRequestId: workflowOrigin.requestId,
            executionRunWorkflowRunId: workflowOrigin.runId,
            executionRunTargetMachineId: workflowBinding.machineId,
            externalActionExecutionAuthorization: workflowAuthorization,
            externalActionTarget: workflowBinding.target,
            serverIdentityId: workflowBinding.serverIdentityId,
            runtimeAccountId: workflowBinding.accountId,
        } : {}),
        ...(workflowWitness && workflowOrigin ? {
            actionCaller: { kind: 'workflowRun' as const, runId: workflowOrigin.runId,
                authorization: workflowWitness.authorization },
            callerPermissionMode: workflowWitness.authorization.admittedPermissionCeiling,
            workspaceWrites: workflowWitness.workspaceWrites,
            defaultSessionId: workflowWitness.runOriginSessionId ?? null,
        } : {}),
        ...(params.reviewedChildActionContext ? {
            // Preserve the issuer's exact credential object across adapter projection.
            externalActionCredential: params.reviewedChildActionContext.externalActionCredential,
        } : {}),
        ...(externalActionContinuation ? { externalActionContinuation: true as const } : {}),
    };
}

export function buildActionExecutorDepsForRpc(
    params: Readonly<{ executorParams: CliActionExecutorParams }>,
): CliActionExecutorParams {
    return params.executorParams;
}

async function resolveRpcActionExecutor<TActionId extends ActionId>(params: RpcActionDispatchRequest<TActionId>): Promise<RpcActionExecutor<TActionId>> {
    const requester = readRequesterAccountRpcActionExecutor(params);
    if (requester) return requester;
    if (params.executor) {
        return params.executor;
    }
    if (!params.executorParams) {
        throw new Error('rpc_action_executor_params_required');
    }
    const module = await import('@/session/actions/createCliActionExecutor');
    return module.createCliActionExecutor(buildActionExecutorDepsForRpc({ executorParams: params.executorParams }));
}

/** Runtime-owned effects retain requester custody without re-entering its transport executor. */
export function readRequesterAccountRpcActionExecutor(
    params: Pick<RpcActionDispatchRequest, 'actionId' | 'requesterApprovalDecision' | 'callerInputAuthorization'>,
) {
    return ACTION_ID_FAMILIES_V1.execution_run_control.some(actionId => actionId === params.actionId)
        || params.actionId === 'approval.request.decide' && params.requesterApprovalDecision
        ? undefined : params.callerInputAuthorization?.requesterAccountExecutor;
}

export async function dispatchActionFromRpc<TActionId extends ActionId>(
    params: RpcActionDispatchRequest<TActionId>,
): Promise<ActionExecuteResult> {
    const executor = await resolveRpcActionExecutor(params);
    return await executor.execute(
        params.actionId,
        params.input,
        buildActionExecutorContextForRpc(params),
    );
}
