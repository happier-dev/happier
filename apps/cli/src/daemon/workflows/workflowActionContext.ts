import type { ActionExecutorContext, WorkflowAcceptedAuthorizationV1, WorkflowAcceptedOriginV1, WorkflowAcceptedSnapshotV1, WorkflowProjectTargetV1 } from '@happier-dev/protocol';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveWorkflowInvocationStructureV1 } from '@happier-dev/protocol/workflows/workflowInvocationStructureV1';
import { resolveWorkflowAcceptedStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { createCredentialedWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';
import type { WorkflowActionAdmission } from './workflowActionAdmission';

/** Host-private context from an accepted Workflow execution, never Action input. */
export function buildWorkflowActionContext(execution: Readonly<{
  runId: string;
  source?: WorkflowAcceptedSnapshotV1['source'];
  invocationRecordId?: string;
  workDepth?: number;
  authorization: WorkflowAcceptedAuthorizationV1;
  origin?: WorkflowAcceptedOriginV1;
  approvalProfileId?: string | null;
  workspace?: Readonly<{ machineId: string }>;
  signal?: AbortSignal;
}>, requesterWorkAttributionV1?: RequesterWorkAttributionV1): ActionExecutorContext {
  const original = execution.authorization.externalActionExecutionAuthorization;
  const binding = original?.binding;
  if (execution.authorization.principal.kind === 'api' && (!original || !binding || 'authentication' in binding)) {
    throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
  }
  const starter = execution.origin?.authenticatedStarterV1;
  const originSessionId = execution.origin?.originSessionId;
  const approvalProfileId = execution.approvalProfileId !== undefined
    ? execution.approvalProfileId : execution.origin?.actionPolicy?.approvalProfileId;
  const approvalProfileTeamOrGroupDerived = execution.approvalProfileId === undefined
    && execution.origin?.actionPolicy?.approvalProfileTeamOrGroupDerived === true;
  // The accepted starter is stamped only by authenticated direct person admission.
  // Agent-authored overrides consume ordinary profile-control consent at child admission.
  const approvalProfileChange = !starter && execution.approvalProfileId !== undefined
    && (execution.approvalProfileId !== (execution.origin?.actionPolicy?.approvalProfileId ?? null)
      || execution.origin?.actionPolicy?.approvalProfileTeamOrGroupDerived === true);
  const attribution = execution.origin?.actionRequestAttributionV1 ?? (starter && originSessionId
    ? { ...starter, persona: { serverId: starter.requester.serverId, sessionId: originSessionId }, origin: null }
    : undefined);
  return {
    surface: 'agent' as const,
    authority: 'account_automation' as const,
    ...(original && binding ? {
      externalActionExecutionAuthorization: original,
      ...(!('authentication' in binding) ? { externalActionCredential: { accountId: binding.accountId, principalId: binding.principalId,
        credentialId: binding.credentialId, grant: binding.grant } } : {}),
      externalActionTarget: binding.target,
      runtimeAccountId: binding.accountId,
    } : {}),
    ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
    ...(approvalProfileId === undefined ? {} : { approvalProfileTeamOrGroupDerived }),
    ...(approvalProfileChange ? { approvalProfileChange: true } : {}),
    actionCaller: {
      kind: 'workflowRun' as const,
      runId: execution.runId,
      ...(execution.source && 'definitionId' in execution.source && execution.source.definitionId
        ? { workflowId: execution.source.definitionId } : {}),
      authorization: execution.authorization,
      ...(starter && !execution.origin?.actionRequestAttributionV1 ? { authenticatedStarterV1: starter } : {}),
    },
    executionRunWorkflowRunId: execution.runId,
    ...(execution.invocationRecordId ? { workflowSessionInput: {
      purpose: 'invocation' as const, runId: execution.runId, invocationRecordId: execution.invocationRecordId,
      ...(execution.workDepth === undefined ? {} : { workDepth: execution.workDepth }),
    } } : {}),
    ...(attribution ? {
      actionRequestAttributionV1: materializeActionRequestAttributionV1(attribution),
    } : {}),
    ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
    ...(execution.workspace ? { executionRunTargetMachineId: execution.workspace.machineId } : {}),
    callerPermissionMode: execution.authorization.admittedPermissionCeiling,
    ...(execution.signal ? { signal: execution.signal } : {}),
  };
}

/** Restore caller and selected policy from the accepted invocation the coordinator used. */
export async function readWorkflowActionPolicyContext(input: Readonly<{
  admission: WorkflowActionAdmission;
  context: ActionExecutorContext;
}> & (Readonly<{ actionId: string; input: unknown; phase?: 'dispatch' }>
  | Readonly<{ phase: 'approval_replay'; resolveContext: ReturnType<typeof createWorkflowActionContextResolver> }>)
): Promise<Pick<ActionExecutorContext, 'actionCaller' | 'actionRequestAttributionV1' | 'approvalProfileId' | 'approvalProfileTeamOrGroupDerived' | 'approvalProfileChange' | 'callerPermissionMode' | 'workflowSessionInput' | 'agentStartContext'> | null> {
  const { admission, context } = input;
  const invocation = await admission.readActionInvocation(input.phase ?? 'dispatch');
  const execution = invocation?.progress.execution;
  if (!invocation || execution?.kind !== 'action' || execution.actionRequestId !== context.actionRequestId
    || (input.phase !== 'approval_replay' && (execution.actionId !== input.actionId
      || !sameStrictJsonValue(execution.input, input.input)))) return null;
  const accepted = admission.accepted;
  const structure = await resolveWorkflowInvocationStructureV1({ definition: accepted.definition,
    frozenChildren: accepted.frozenChildren, inputs: accepted.inputs, invocation,
    readInvocation: admission.readInvocation, keyOfInvocation: row => row.index.id });
  if (structure?.leaf.kind !== 'action' || structure.leaf.actionId !== execution.actionId) return null;
  const blockId = structure.leaf.id;
  const frozen = accepted.materializedLeaves.find(leaf => leaf.kind === 'action'
    && leaf.sourceKey === structure.sourceKey && leaf.blockId === blockId && leaf.actionId === execution.actionId);
  if (!frozen) return null;
  const selected = resolveWorkflowAcceptedStepSelectionV1(frozen, structure.frame.item?.value, structure.inputs);
  const executionContext = { runId: admission.run.id, source: accepted.source, invocationRecordId: invocation.index.id,
    workDepth: accepted.workDepth, authorization: accepted.authorization,
    workspace: accepted.workspaceTarget.project,
    ...(accepted.origin?.originSessionId ? { originSessionId: accepted.origin.originSessionId } : {}),
    ...(selected.role ? { role: selected.role } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(accepted.origin ? { origin: accepted.origin } : {}),
    ...(selected.selection.approvalProfileId === undefined ? {} : { approvalProfileId: selected.selection.approvalProfileId }) };
  const policy = input.phase === 'approval_replay'
    ? await input.resolveContext(executionContext) : buildWorkflowActionContext(executionContext);
  return { actionCaller: policy.actionCaller, actionRequestAttributionV1: policy.actionRequestAttributionV1,
    approvalProfileId: policy.approvalProfileId, approvalProfileTeamOrGroupDerived: policy.approvalProfileTeamOrGroupDerived,
    approvalProfileChange: policy.approvalProfileChange,
    callerPermissionMode: policy.callerPermissionMode, workflowSessionInput: policy.workflowSessionInput,
    ...(policy.agentStartContext ? { agentStartContext: policy.agentStartContext } : {}) };
}

/** Fresh host policy and accepted Run facts for new Workflow work, never Action operands. */
export function createWorkflowActionContextResolver(
  resolveMaterializer: ReturnType<typeof createCredentialedWorkflowMaterializationHostV1>,
  requesterWorkAttributionV1?: RequesterWorkAttributionV1,
): (execution: Readonly<{
  runId: string;
  source?: WorkflowAcceptedSnapshotV1['source'];
  invocationRecordId?: string;
  authorization: WorkflowAcceptedAuthorizationV1;
  workspace: WorkflowProjectTargetV1;
  workDepth: number;
  originSessionId?: string;
  origin?: WorkflowAcceptedOriginV1;
  approvalProfileId?: string | null;
  role?: import('@happier-dev/protocol').WorkflowMaterializedLeafV1['role'];
  signal?: AbortSignal;
}>) => Promise<ActionExecutorContext> {
  return async execution => {
    const materialization = await resolveMaterializer({ machineId: execution.workspace.machineId,
      directory: execution.workspace.directory, ...(execution.signal ? { signal: execution.signal } : {}) });
    const current = materialization.agentStartPolicySnapshot;
    const context = buildWorkflowActionContext(execution, requesterWorkAttributionV1);
    return { ...context, defaultSessionId: execution.originSessionId ?? null,
      workspaceWrites: execution.role?.workspaceWrites ?? 'allow',
      externalActionTarget: context.externalActionTarget ?? { kind: 'machine' as const, machineId: execution.workspace.machineId,
        project: { machineId: execution.workspace.machineId, directory: execution.workspace.directory,
          ...(execution.workspace.workspaceRefId ? { workspaceRefId: execution.workspace.workspaceRefId } : {}) } },
      sessionAgentSpawnPolicyV1: current.policy,
      agentStartContext: { caller: { kind: 'originless' as const, runId: execution.runId, runDepth: execution.workDepth,
          ...(execution.originSessionId ? { runOriginSessionId: execution.originSessionId } : {}) },
        baseline: { machineId: execution.workspace.machineId, directory: execution.workspace.directory },
        ledSubtreeSessionIds: [], roles: execution.role ? { [execution.role.roleId]: execution.role } : {},
        callerPermissionCeiling: execution.authorization.admittedPermissionCeiling,
        workDepthLimit: current.workDepthLimit, allowLists: current.allowLists } };
  };
}
