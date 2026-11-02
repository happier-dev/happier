import type { RuntimeActionIdV1 } from '@happier-dev/protocol';
import { requiredMachineRoleForBrowserAction } from '@happier-dev/protocol/actions';

import type { TrackedSession } from './types';

/** Session control ingress consumes private custody already decided at Machine admission. */
export function canExecuteSessionRuntimeAction(
  action: Readonly<{ actionId: RuntimeActionIdV1; input: unknown }>,
  resolveRequester: () => TrackedSession['requesterSessionRuntimeContext'],
): boolean {
  if (requiredMachineRoleForBrowserAction(action.actionId, action.input) !== 'manage') return true;
  const requester = resolveRequester();
  return !requester || requester.bootstrap.savedSecretOperationContext.machineAdmission?.role === 'manage';
}
