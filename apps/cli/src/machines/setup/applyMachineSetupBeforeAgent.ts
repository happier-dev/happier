import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol';
import { buildMachineSetupTargetApplyInput, machineSetupApplyTargetFromPlanV1,
  MachineSetupPlanResultV1Schema, ManagedMachineActionOutputSchemasV1, waitForMachineSetupOperationV1,
  type MachineSetupPlanInputV1, type MachineSetupApplyInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ActionOperationGetV2Request } from '@happier-dev/protocol/actions/operations/v1';

/** Agent startup requires successful setup; failure or recorded uncertainty stops it. */
export async function applyMachineSetupBeforeAgent(input: Readonly<{
  planInput: MachineSetupPlanInputV1;
  plan(): Promise<ActionExecuteResult>;
  apply(operand: MachineSetupApplyInputV1): Promise<ActionExecuteResult>;
  observe(request: ActionOperationGetV2Request): Promise<unknown>;
}>): Promise<ActionExecuteFailure | null> {
  const planned = await input.plan();
  if (!planned.ok) return planned;
  const target = machineSetupApplyTargetFromPlanV1(input.planInput, MachineSetupPlanResultV1Schema.parse(planned.result));
  const applied = await input.apply(buildMachineSetupTargetApplyInput(target));
  if (!applied.ok) return applied;
  const receipt = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].parse(applied.result);
  return await waitForMachineSetupOperationV1(receipt.operationId, input.observe);
}
