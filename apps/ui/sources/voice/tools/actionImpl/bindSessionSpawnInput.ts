import { SessionSpawnNewActionVoiceInputV2Schema, type SessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { AgentsBackendsListOutput } from '@happier-dev/protocol/actions/agentBackendInventory';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { actionInputValidationFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';

import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Bind the inventory owner's exact default; never reconstruct an identity from its key. */
export async function bindVoiceSessionSpawnInput(
  input: unknown,
  execute: FrontDoorActionExecute,
  signal?: AbortSignal,
): Promise<Readonly<{ ok: true; input: SessionSpawnNewActionInputV2 }> | ActionExecuteFailure> {
  const parsed = SessionSpawnNewActionVoiceInputV2Schema.safeParse(input);
  if (!parsed.success) return actionInputValidationFailure(parsed.error);
  if (parsed.data.agentTarget !== undefined) return { ok: true, input: { ...parsed.data, agentTarget: parsed.data.agentTarget } };

  const listed = await execute('agents.backends.list', { machineId: parsed.data.executionTarget.machineId }, {
    surface: 'voice', serverId: parsed.data.executionTarget.serverId, ...(signal ? { signal } : {}),
  });
  if (!listed.ok) return listed;
  // The Action owner validates this result; the host consumes its selection.
  const inventory = listed.result as AgentsBackendsListOutput;
  const agentTarget = inventory.items.find(item => item.enabled && item.targetKey === inventory.defaultTargetKey)?.agentTarget;
  if (!agentTarget) return { ok: false, errorCode: 'unknown_agent', error: 'unknown_agent' };
  return { ok: true, input: { ...parsed.data, agentTarget } };
}
