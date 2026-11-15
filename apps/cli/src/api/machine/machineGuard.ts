import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MACHINE_GUARD_ACTION_INPUT_SCHEMAS, MACHINE_GUARD_ACTION_OUTPUT_SCHEMAS, type MachineGuardActionId } from '@happier-dev/protocol/actions/specs/machineGuard';
import { executeCapturedMachineAction } from './capturedMachineAction';
import { resolveMachineGuardOperationTimeoutMs } from '@happier-dev/protocol/machines/guard/actionIdsV1';
import { readDeploymentOutputValidationFailure } from '@/deployments/outputValidation';
import type { core } from 'zod/mini';

/** The existing exact-Machine transport owns credentials, admission, and Home placement. */
export async function executeMachineGuardAction(input: Readonly<{
  actionId: MachineGuardActionId; input: unknown; serverId: string;
  assertCurrent: () => Promise<void>;
  call: (request: Readonly<{ machineId: string; method: string; input: unknown; timeoutMs?: null }>) => Promise<unknown>;
}>): Promise<unknown> {
  const request = MACHINE_GUARD_ACTION_INPUT_SCHEMAS[input.actionId].parse(input.input);
  if (request.serverId && request.serverId !== input.serverId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
  const raw = await executeCapturedMachineAction({ actionId: input.actionId, assertCurrent: input.assertCurrent,
    invoke: options => input.call({ machineId: request.machineId, method: getActionSpec(input.actionId).bindings!.rpcMethod!,
      input: { ...request, serverId: input.serverId }, ...options,
      ...(resolveMachineGuardOperationTimeoutMs(input.actionId) === null ? { timeoutMs: null } : {}) }) });
  const failure = ActionExecuteFailureSchema.safeParse(raw);
  if (failure.success) return failure.data;
  const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
  if (deferred.success && deferred.data.actionId === input.actionId) return deferred.data;
  // The transport returns unknown; retain the exact Action schema while avoiding
  // inference of the full nested schema union at this validation boundary.
  const outputSchema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: core.$ZodError } }
    = MACHINE_GUARD_ACTION_OUTPUT_SCHEMAS[input.actionId];
  const output = outputSchema.safeParse(raw);
  if (output.success) return output.data;
  // Keep the Action id and content-free issue paths/codes so a malformed Machine reply is diagnosable.
  return readDeploymentOutputValidationFailure('invalid_action_output', output.error, input.actionId);
}
