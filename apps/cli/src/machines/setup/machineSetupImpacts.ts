import type { MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

type AuthoredImpact = NonNullable<Extract<MachineRecipeStepV1, { kind: 'command' }>['affects']>;
export type MachineSetupStepImpactReference = Readonly<{ kind: 'selected'; affects: AuthoredImpact }>
  | Readonly<{ kind: 'localDocker' }>;

/** One classifier feeds both review disclosure and native authority resolution. */
export function readMachineSetupStepImpactReference(step: MachineRecipeStepV1): MachineSetupStepImpactReference | undefined {
  if (step.kind === 'script') return step.affects === 'dockerEngine' ? { kind: 'localDocker' }
    : step.affects ? { kind: 'selected', affects: step.affects } : undefined;
  if (step.kind === 'command') return step.affects ? { kind: 'selected', affects: step.affects } : undefined;
  if (step.kind === 'serviceUnit' && (step.unit === 'docker.service' || step.unit === 'containerd.service'))
    return { kind: 'localDocker' };
  if (step.kind === 'file' && (step.validate === 'docker' || typeof step.validate === 'object' && step.validate.kind === 'docker'
    || step.probe?.kind === 'docker')) return { kind: 'localDocker' };
  return undefined;
}

/** The authored impact already reserved by the native setup admission owner. */
export function readMachineSetupStepImpact(step: MachineRecipeStepV1):
  AuthoredImpact | undefined {
  const reference = readMachineSetupStepImpactReference(step);
  return reference?.kind === 'localDocker' ? 'dockerEngine' : reference?.affects;
}
