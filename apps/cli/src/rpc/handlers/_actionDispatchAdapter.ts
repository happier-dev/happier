import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import type { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import type { RpcLocalActionContext, RpcHandlerContext } from '@/api/rpc/types';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncSourceContextV1Schema } from '@happier-dev/protocol/socketRpc';

type CliActionExecutorParams = Parameters<typeof createCliActionExecutor>[0];

type HostRequesterContext = Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent'
    | 'requesterSessionBootstrap' | 'sessionActionOrigin' | 'callerInputAuthorization' | 'callerInputConstraints'
    | 'workspaceSyncSourceRouting' | 'workspaceSyncTargetRouting' | 'workspaceSyncSourceWriterTargetRouting' | 'workspaceSyncSeedRouting'
    | 'originalActionEnvelope' | 'workspaceSyncSourceExecution'>;

export type RpcActionExecutorContext = ActionExecutorContext & HostRequesterContext & Readonly<{
    signal?: AbortSignal;
    operationProgress?: NonNullable<RpcLocalActionContext['operationProgress']>;
    operationOwnerUpdate?: NonNullable<RpcLocalActionContext['operationOwnerUpdate']>;
    requesterWorkAttributionV1?: RpcLocalActionContext['requesterWorkAttributionV1'];
    operationReview?: RpcLocalActionContext['operationReview'];
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

export type RpcActionExecutor = Readonly<{
    execute: (
        actionId: ActionId,
        input: unknown,
        context?: RpcActionExecutorContext,
    ) => Promise<ActionExecuteResult>;
}>;

export type RpcActionDispatchRequest = HostRequesterContext & Readonly<{
    actionId: ActionId;
    input: unknown;
    defaultSessionId?: string | null;
    serverId?: string | null;
    externalActionTarget?: ActionExecutorContext['externalActionTarget'];
    signal?: AbortSignal;
    localActionContext?: RpcLocalActionContext;
    callerAuthority?: ActionExecutorContext['authority'];
    sessionActionOrigin?: SessionActionRpcOriginV1;
    rpcSessionAuthorization?: ActionExecutorContext['rpcSessionAuthorization'];
    runtimeAccountId?: ActionExecutorContext['runtimeAccountId'];
    externalActionExecutionAuthorization?: ActionExecutorContext['externalActionExecutionAuthorization'];
    executor?: RpcActionExecutor;
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
    params: Pick<RpcActionDispatchRequest, 'defaultSessionId' | 'serverId' | 'externalActionTarget' | 'signal' | 'localActionContext' | 'callerAuthority' | 'sessionActionOrigin' | 'rpcSessionAuthorization' | 'runtimeAccountId' | 'externalActionExecutionAuthorization' | keyof HostRequesterContext>
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
    const workspaceSourceContext = params.workspaceSyncSourceWriterTargetRouting?.source.sourceContext
        ?? params.workspaceSyncSeedRouting?.sourceWriterTarget.source.sourceContext;

    return {
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
        ...(params.runtimeAccountId ? { runtimeAccountId: params.runtimeAccountId } : {}),
        ...(params.externalActionExecutionAuthorization
            ? { externalActionExecutionAuthorization: params.externalActionExecutionAuthorization } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
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
        ...(localActionContext?.executionRunTargetMachineId
            ? { executionRunTargetMachineId: localActionContext.executionRunTargetMachineId }
            : {}),
        surface,
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
        ...(requesterAuthorization && !params.sessionActionOrigin ? {
            surface: 'authentication' in requesterAuthorization.binding ? 'ui' as const : 'api' as const,
            actionRequestId: requesterAuthorization.binding.requestId,
            serverId: requesterAuthorization.requesterAccountProjection!.serverId,
            serverIdentityId: requesterAuthorization.binding.serverIdentityId,
            externalActionTarget: requesterAuthorization.binding.target,
            ...('grant' in requesterAuthorization.binding ? { externalActionCredential: {
                accountId: requesterAuthorization.binding.accountId,
                principalId: requesterAuthorization.binding.principalId,
                credentialId: requesterAuthorization.binding.credentialId,
                grant: requesterAuthorization.binding.grant,
            } } : {}),
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
            sessionInputSource: { sourceSessionId: params.sessionActionOrigin.caller.sessionId,
                sourceTurnId: params.sessionActionOrigin.sourceTurnId, via: 'action' as const },
            ...(params.sessionActionOrigin.workspaceWrites ? { workspaceWrites: params.sessionActionOrigin.workspaceWrites } : {}),
        } : {}),
    };
}

export function buildActionExecutorDepsForRpc(
    params: Readonly<{ executorParams: CliActionExecutorParams }>,
): CliActionExecutorParams {
    return params.executorParams;
}

async function resolveRpcActionExecutor(params: RpcActionDispatchRequest): Promise<RpcActionExecutor> {
    const requester = params.callerInputAuthorization?.requesterAccountExecutor;
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

export async function dispatchActionFromRpc(
    params: RpcActionDispatchRequest,
): Promise<ActionExecuteResult> {
    const executor = await resolveRpcActionExecutor(params);
    return await executor.execute(
        params.actionId,
        params.input,
        buildActionExecutorContextForRpc(params),
    );
}
