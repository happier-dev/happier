import type { ActionExecuteFailure } from '../actionExecutionResult.js';
import type { ActionExecutorContext } from './types.js';

/**
 * Acquiring-Account authoring preference, not effect authority. Origination
 * hosts project their own readable settings; receivers never borrow custody
 * settings or reconstruct this fact from Action input.
 */
export function resolveActionOriginationPreferenceFailureV1(
  actionId: string,
  context: Pick<ActionExecutorContext, 'managedMachineCreationEnabled'> | undefined,
): ActionExecuteFailure | null {
  return actionId === 'machines.managed.acquire' && context?.managedMachineCreationEnabled === false
    ? { ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' }
    : null;
}
