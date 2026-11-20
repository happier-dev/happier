import type { MachineRecipeStepV1, MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { checkElevatedMachineSetupPlanResult, type MachineElevationDependencies } from '../adminAccess/runElevatedEffect';

export function readProtectedMachineFirewall(input: Readonly<{
  machineId: string;
  requestId: string;
  signal?: AbortSignal;
  basis: MachineSetupEffectPlanV1['basis'];
  step: Extract<MachineRecipeStepV1, { kind: 'firewall' }>;
  allowPrompt?: false;
}>, elevation: MachineElevationDependencies) {
  return checkElevatedMachineSetupPlanResult({ machineId: input.machineId, operationId: input.requestId,
    signal: input.signal, basis: input.basis, steps: [input.step], allowPrompt: input.allowPrompt }, elevation);
}
