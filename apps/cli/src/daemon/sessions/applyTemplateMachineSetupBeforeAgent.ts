import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { readTemplateRequesterSetupPlanInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildMachineSetupTargetApplyInput, machineSetupApplyTargetFromPlanV1,
  MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema,
  ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import type { ApiMachineClient } from '@/api/apiMachine';
import { readReviewedExternalActionInput, resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import type { PrepareExternalActionRequesterAccountContext } from '@/daemon/externalActions/executeExternalAction';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

type PreparedRequester = NonNullable<Awaited<ReturnType<PrepareExternalActionRequesterAccountContext>>>;

/** A creation recipe retains admission; the existing requester ingress proves it before any setup effect. */
export async function applyTemplateMachineSetupBeforeAgent(input: Readonly<{
  options: SpawnSessionOptions;
  machineId: string;
  serverId: string;
  prepareRequester: PrepareExternalActionRequesterAccountContext;
  invokeMachineAction: ApiMachineClient['invokeLocalMachineAction'];
  operationContext(prepared: PreparedRequester): Pick<RpcActionExecutorContext,
    'machineAdmission' | 'verifyMachineAdmissionCurrent'> | null;
  signal?: AbortSignal;
}>): Promise<ActionExecuteFailure | null> {
  const execution = input.options.machineSetupExecution;
  const plan = MachineSetupPlanInputV1Schema.safeParse(input.options.machineSetupPlanInput);
  const denied = (): ActionExecuteFailure => ({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  if (!execution || !plan.success || plan.data.machineId !== input.machineId) return denied();
  const prepared = await input.prepareRequester({ authorization: execution.authorization,
    templateRequesterSetup: { planInputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', plan.data) },
    ...(input.signal ? { signal: input.signal } : {}) });
  if (!prepared) return denied();
  try {
    const admittedPlan = readTemplateRequesterSetupPlanInputV1({ ...execution,
      authorization: prepared.authorization, input: plan.data });
    const operation = input.operationContext(prepared);
    if (!admittedPlan || !operation?.machineAdmission) return denied();
    const binding = prepared.authorization.binding;
    const context: RpcActionExecutorContext = { ...operation,
      actionRequestId: binding.requestId, runtimeAccountId: binding.accountId,
      serverId: input.serverId, serverIdentityId: binding.serverIdentityId,
      externalActionExecutionAuthorization: prepared.authorization,
      originalActionEnvelope: execution.originalActionEnvelope, externalActionTarget: binding.target,
      surface: prepared.invocation?.surface ?? 'rpc', actionCaller: { kind: 'host' },
      authority: prepared.invocation?.authority ?? resolveExternalActionRootInvocationAuthority(prepared.authorization),
      ...(prepared.actionsSettings ? { actionsSettings: prepared.actionsSettings } : {}),
      ...(input.signal ? { signal: input.signal } : {}) };
    const openedInput = await readReviewedExternalActionInput({ authorization: prepared.authorization,
      envelope: execution.originalActionEnvelope, ...(input.signal ? { signal: input.signal } : {}) });
    if (!openedInput || typeof openedInput !== 'object' || Array.isArray(openedInput)) return denied();
    const parentInput = projectNativeJsonValueForTransport(openedInput);
    if (!parentInput || typeof parentInput !== 'object' || Array.isArray(parentInput)) return denied();
    const parent = { actionId: 'template.instantiate' as const, input: parentInput as Readonly<Record<string, JsonValue>> };
    const invoke = async (action: 'machines.setup.plan' | 'machines.setup.apply', role: string,
      operand: unknown): Promise<ActionExecuteResult> => await invokeHostReviewedChildV1({
        parent, context, receivingAdmission: operation.machineAdmission,
        child: { action, role, input: projectNativeJsonValueForTransport(operand) },
        admittedReview: { action, role, surface: context.surface ?? 'rpc' },
        execute: (value, childContext, actionId) => prepared.executor.execute(actionId, value, childContext),
      });
    const planned = await invoke('machines.setup.plan', 'template_setup_plan', admittedPlan);
    if (!planned.ok) return planned;
    const target = machineSetupApplyTargetFromPlanV1(admittedPlan, MachineSetupPlanResultV1Schema.parse(planned.result));
    // Apply acknowledges its persisted Workflow before its native children finish.
    // Join that same operation through the incumbent blocking observation owner.
    const applied = await invoke('machines.setup.apply', 'template_setup_apply', buildMachineSetupTargetApplyInput(target));
    if (!applied.ok) return applied;
    const receipt = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].parse(applied.result);
    const settled = ActionOperationGetV1ResponseSchema.parse(await input.invokeMachineAction(
      ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: receipt.operationId, waitForTerminal: true },
      { ...(input.signal ? { signal: input.signal } : {}), rpcContext: operation }));
    if (settled.kind !== 'found') return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
    if (settled.operation.state === 'succeeded') return null;
    const failure = settled.operation.error;
    const code = settled.operation.state === 'cancelled' ? 'cancelled' : 'machine_setup_child_failed';
    return { ok: false, errorCode: failure?.errorCode ?? code, error: failure?.error ?? code,
      ...(failure?.details ? { details: failure.details } : {}) };
  } finally {
    await prepared.dispose();
  }
}
