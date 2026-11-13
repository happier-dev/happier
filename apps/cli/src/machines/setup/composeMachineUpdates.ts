import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import type { WorkflowCombinedRunStartV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { createMachineUpdatesRolloutWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/machineUpdatesV1';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { prepareWorkflowRunStartV1 } from '@happier-dev/protocol/workflows/workflowStartPreparationV1';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';

const failure = (errorCode: string, runId?: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode,
  ...(runId ? { details: { runId } } : {}) });

/** Composition only; the existing Run owns native-operation joins, stop, persistence and recovery. */
export function createMachineUpdatesRolloutActionDeps(host: Readonly<{
  orchestrationDirectory: string;
  startCombined(request: WorkflowCombinedRunStartV1): Promise<unknown>;
  waitForRun(request: WorkflowCombinedRunStartV1): Promise<unknown>;
}>): Pick<ActionExecutorDeps, 'machineSetupUpdatesRollout'> {
  return { machineSetupUpdatesRollout: async ({ input, context }) => {
    const acceptance = context.operationAcceptance;
    if (acceptance?.actionId !== MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1 || !context.runtimeAccountId || !context.actionRequestId)
      return failure('admission_unavailable');
    const binding = context.externalActionExecutionAuthorization?.binding;
    const reviewedChild = binding ? readHostAdmittedReviewedChildV1(context) : null;
    const runId = deriveMachineSetupCombinedRunIdV1({ actionId: MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1,
      homeId: binding?.serverIdentityId ?? input.homeId, accountId: binding?.accountId ?? context.runtimeAccountId,
      requestId: binding?.requestId ?? context.actionRequestId, ...(reviewedChild ? { reviewedChild } : {}) });
    const target = context.externalActionTarget;
    const orchestrationTarget = target?.kind === 'machine' && target.machineId === input.machineId
      && target.project?.machineId === input.machineId ? target.project
      : { machineId: input.machineId, directory: host.orchestrationDirectory };
    const request: WorkflowCombinedRunStartV1 = { parent: { actionId: MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1, input },
      start: { runId, executionTarget: { kind: 'session' },
        source: prepareWorkflowRunStartV1({ definition: createMachineUpdatesRolloutWorkflowV1(input) }).source }, context, orchestrationTarget };
    const started = await host.startCombined(request);
    const refused = ActionExecuteFailureSchema.safeParse(started);
    if (refused.success) return refused.data;
    if (!WorkflowActionOutputSchemasV1['workflow.run.start'].safeParse(started).success) return failure('machine_setup_unavailable');
    context.operationOwnerUpdate?.update({ cancellation: 'unsupported' });
    const receipt = { operationId: acceptance.operationId, runId };
    acceptance.accept(receipt);
    let observed: unknown;
    try { observed = await host.waitForRun(request); }
    catch (error) { return { ...failure('outcome_uncertain', runId),
      failureCause: normalizeActionExecutorThrownError(error, 'workflow.run.wait').failureCause }; }
    const settled = WorkflowActionOutputSchemasV1['workflow.run.wait'].safeParse(observed);
    if (!settled.success || settled.data.observation !== 'terminal' && settled.data.observation !== 'needs_attention'
      || settled.data.run.workflowCustodyState !== 'settled' && settled.data.run.state !== 'interrupted')
      return failure(context.signal?.aborted ? 'stop_unconfirmed' : 'outcome_uncertain', runId);
    return settled.data.run.state === 'succeeded' ? receipt
      : failure(settled.data.run.state === 'cancelled' ? 'cancelled' : 'machine_setup_child_failed', runId);
  } };
}
