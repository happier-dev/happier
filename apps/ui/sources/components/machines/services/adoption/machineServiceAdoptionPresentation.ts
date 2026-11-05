import type { MachineServiceRowV1 } from '@happier-dev/protocol';
import type { EnvironmentVariableBindingV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { MachineServiceAdoptResultV1 } from '@happier-dev/protocol/actions/specs/machine/serviceAdoption';

import { machineServiceKind } from '../machineServicesPresentation';

type Variable = Extract<MachineServiceAdoptResultV1, { kind: 'review' }>['variables'][number];

/**
 * Only a Compose project the person watches (Machine authority, Compose adapter) at a known generation can be
 * adopted: a deployed service already belongs to an Environment, and another adapter can't capture a definition.
 */
export function canAdoptMachineService(row: MachineServiceRowV1): boolean {
  return row.authority === 'machine' && row.generation !== null && machineServiceKind(row) === 'compose'
    && row.unavailableReason === undefined;
}

/** How many captured variables still need a value or a saved secret. The Action refuses any other set of bindings. */
export function machineServiceAdoptionMissing(variables: readonly Variable[], bindings: readonly EnvironmentVariableBindingV1[]): number {
  return variables.filter(variable => !bindings.some(binding => binding.name === variable.name && binding.phase === variable.phase)).length;
}
