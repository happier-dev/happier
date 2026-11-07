/** @moduleRealm any */
import { classifyManagedMachineAllocationV1 as canonicalClassify } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';

export type ManagedMachineAllocationPresentationV1 = PluginActionResultById['machines.managed.list']['machines'][number]['allocation'] | 'creating';

/** Supply only a creation operation already correlated by its owner; absence means the outcome is uncertain. */
export const classifyManagedMachineAllocationV1: (
  machine: Pick<PluginActionResultById['machines.managed.list']['machines'][number], 'allocation'>,
  currentCreationOperation?: Pick<Extract<PluginActionResultById['action.operations.get'], { kind: 'found' }>['operation'], 'actionId' | 'state'> | null,
) => ManagedMachineAllocationPresentationV1 = /* @__PURE__ */ projectProtocolValue(canonicalClassify);
