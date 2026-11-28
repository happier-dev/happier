import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { MachineSetupApplyResultV1Schema, waitForMachineSetupOperationV1 } from '../../machines/managed/actionsV1.js';
import { OpenProjectResultV1Schema } from '../../projects/openProjectV1.js';
import { TEAM_SETUP_RUN_ACTION_ID_V1, TEAM_SETUP_RUN_CHILD_ACTION_IDS_V1 as CHILD } from '../../teams/actionIdsV1.js';
import type { TeamSetupBatchInputV1, TeamSetupBatchResultV1 } from '../../teams/setupBatchV1.js';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema, type ActionExecuteResult } from '../actionExecutionResult.js';
import { isPresentUserHostInvocation } from '../invocationAuthority.js';
import { readHostAdmittedReviewedParentV1 } from './deploymentRoleChild.js';
import type { ActionExecutorContext, HostReviewedChildrenPlanV1 } from './types.js';

/** The ordered child declarations are the effects covered by either front door's review. */
export function describeTeamSetupBatch(input: TeamSetupBatchInputV1) {
  return [
    ...(input.machine ? [
      { action: CHILD.machine, role: 'machine', input: projectNativeJsonValueForTransport(input.machine) },
      { action: CHILD.operation, role: CHILD.operation, scopeInput: {
        serverId: input.homeId, machineId: input.machineId, waitForTerminal: true,
      } },
    ] : []),
    ...input.repositories.map(({ id, input }) => ({ action: CHILD.repository, role: `repository:${id}`,
      input: projectNativeJsonValueForTransport(input) })),
  ] satisfies HostReviewedChildrenPlanV1['children'];
}

function decodeOwnerResult<T>(result: ActionExecuteResult, parse: (value: unknown) => T) {
  if (!result.ok) return ActionExecuteFailureSchema.parse(result);
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
  return { ok: true as const, result: approval.success ? approval.data : parse(result.result) };
}

export async function runTeamSetupBatch(
  input: TeamSetupBatchInputV1,
  context: ActionExecutorContext,
): Promise<ActionExecuteResult> {
  const review = context.hostReviewedChild;
  if (!isPresentUserHostInvocation(context) || !review
    || readHostAdmittedReviewedParentV1(review)?.actionId !== TEAM_SETUP_RUN_ACTION_ID_V1) {
    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  }
  let machine: TeamSetupBatchResultV1['machine'] = null;
  let machineSettlement: TeamSetupBatchResultV1['machineSettlement'] = null;
  const repositories: TeamSetupBatchResultV1['repositories'] = [];
  for (const child of describeTeamSetupBatch(input)) {
    if (context.signal?.aborted) break;
    if (child.input === undefined) continue;
    if (child.action === CHILD.machine) {
      machine = decodeOwnerResult(await review.invoke({ action: child.action, role: child.role, input: child.input }),
        value => MachineSetupApplyResultV1Schema.parse(value));
      context.onTeamSetupBatchProgress?.({ kind: 'machineApplied', result: machine });
      if (!machine.ok || !('operationId' in machine.result)) break;
      const { operationId } = machine.result;
      const observed = await review.invoke({ action: CHILD.operation, role: CHILD.operation, input: {
        serverId: input.homeId, machineId: input.machineId, operationId, waitForTerminal: true,
      } });
      const failure = observed.ok
        ? await waitForMachineSetupOperationV1(operationId, async () => observed.result)
        : ActionExecuteFailureSchema.parse(observed);
      if (failure) {
        machineSettlement = failure;
        break;
      }
    } else {
      const { id } = input.repositories[repositories.length]!;
      context.onTeamSetupBatchProgress?.({ kind: 'repositoryOpening', id });
      const result = decodeOwnerResult(await review.invoke({ action: child.action, role: child.role, input: child.input }),
        value => OpenProjectResultV1Schema.parse(value));
      repositories.push({ id, result });
    }
  }
  const machineReady = !input.machine || Boolean(machine?.ok && 'operationId' in machine.result && !machineSettlement);
  const completed = !context.signal?.aborted && machineReady && repositories.length === input.repositories.length
    && repositories.every(({ result }) => result.ok && 'kind' in result.result
      && result.result.kind === 'opened' && result.result.setup === 'notRequired');
  return { ok: true, result: { completed, machine, machineSettlement, repositories } satisfies TeamSetupBatchResultV1 };
}
