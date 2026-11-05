import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupScriptV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { readMachineSetupPotentialEffectStepsV1 } from '@happier-dev/cli-common/machineSetup';
import { readNativeDockerEffectEngines } from '@/daemon/local/services/launch/nativeComposeEngine';
import { MachineNativeEffectAdmissionError, type MachineNativeEffectKey, type MachineNativeEffectScope } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { readMachineSetupStepImpactReference } from './machineSetupImpacts';

export type MachineSetupNativeEffectsInput = Readonly<{
  environmentIo: Pick<ProjectNativeToolchainIo, 'run'>;
  userHomeDirectory: string;
  hostEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  scripts?: readonly MachineSetupScriptV1[];
  plans?: readonly MachineSetupEffectPlanV1[];
  includeDockerEngine?: true;
  resolveSetupScriptServiceEffects?: (serviceIds: readonly string[]) => Promise<readonly MachineNativeEffectKey[]>;
}>;

/** Resolve the complete reviewed program before native admission or caller effects. */
export async function resolveMachineSetupNativeEffects(input: MachineSetupNativeEffectsInput): Promise<MachineNativeEffectScope> {
  const keys: MachineNativeEffectKey[] = [{ kind: 'machineSetup' }];
  const env = Object.fromEntries(Object.entries(input.hostEnvironment ?? process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const selected: NonNullable<MachineSetupScriptV1['affects']>[] = [];
  let localDocker = input.includeDockerEngine === true;
  // Omitted impact stays unknown; only an authored effect selects extra native keys.
  for (const script of input.scripts ?? []) if (script.body && script.affects !== undefined) selected.push(script.affects);
  for (const steps of readMachineSetupPotentialEffectStepsV1({ plans: input.plans ?? [] })) for (const step of steps) {
    const impact = readMachineSetupStepImpactReference(step);
    if (impact?.kind === 'localDocker') localDocker = true;
    else if (impact) selected.push(impact.affects);
  }
  let allNative: true | undefined;
  if (localDocker || selected.includes('dockerEngine')) {
    const impact = await readNativeDockerEffectEngines({ io: input.environmentIo, command: 'docker', prefix: [],
      cwd: input.userHomeDirectory, env, signal: input.signal });
    allNative = impact.allNative;
    keys.push(...impact.dockerEngineIds.map(dockerEndpoint => ({ kind: 'dockerEngine' as const, dockerEndpoint })));
  }
  const serviceIds = [...new Set(selected.flatMap(impact => typeof impact === 'object' ? impact.services : []))];
  if (serviceIds.length) {
    if (!input.resolveSetupScriptServiceEffects) throw new MachineNativeEffectAdmissionError('admission_unavailable');
    keys.push(...await input.resolveSetupScriptServiceEffects(serviceIds));
  }
  return { keys, ...(allNative ? { allNative } : {}) };
}
