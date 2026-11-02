import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupScriptV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { readMachineSetupPotentialEffectStepsV1 } from '@happier-dev/cli-common/machineSetup';
import { assertNativeComposeAvailable, readNativeDockerEffectEngines } from '@/daemon/local/services/launch/nativeComposeEngine';
import { MachineNativeEffectAdmissionError, type MachineNativeEffectKey } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { readMachineSetupStepImpactReference } from './machineSetupImpacts';

export type MachineSetupNativeEffectsInput = Readonly<{
  environmentIo: Pick<ProjectNativeToolchainIo, 'run'>;
  userHomeDirectory: string;
  hostEnvironment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  scripts?: readonly MachineSetupScriptV1[];
  plans?: readonly MachineSetupEffectPlanV1[];
  resolveSetupScriptServiceEffects?: (serviceIds: readonly string[]) => Promise<readonly MachineNativeEffectKey[]>;
}>;

/** Authored scripts select their engine through their actual execution environment. */
export async function resolveMachineSetupImpactKeys(input: MachineSetupNativeEffectsInput,
  affects: NonNullable<MachineSetupScriptV1['affects']>, env: Readonly<Record<string, string>>): Promise<readonly MachineNativeEffectKey[]> {
  if (affects === 'none') return [];
  if (affects === 'dockerEngine') return [{ kind: 'dockerEngine', dockerEndpoint: await assertNativeComposeAvailable({
    io: input.environmentIo, command: 'docker', prefix: [], cwd: input.userHomeDirectory, env, signal: input.signal }) }];
  if (!input.resolveSetupScriptServiceEffects) throw new MachineNativeEffectAdmissionError('admission_unavailable');
  return input.resolveSetupScriptServiceEffects(affects.services);
}

/** Resolve the complete reviewed program before native admission or caller effects. */
export async function resolveMachineSetupNativeEffectKeys(input: MachineSetupNativeEffectsInput): Promise<readonly MachineNativeEffectKey[]> {
  const keys: MachineNativeEffectKey[] = [{ kind: 'machineSetup' }];
  const env = Object.fromEntries(Object.entries(input.hostEnvironment ?? process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const selected: NonNullable<MachineSetupScriptV1['affects']>[] = [];
  let localDocker = false;
  // Omitted impact stays unknown; only an authored effect selects extra native keys.
  for (const script of input.scripts ?? []) if (script.body && script.affects !== undefined) selected.push(script.affects);
  for (const steps of readMachineSetupPotentialEffectStepsV1({ plans: input.plans ?? [] })) for (const step of steps) {
    const impact = readMachineSetupStepImpactReference(step);
    if (impact?.kind === 'localDocker') localDocker = true;
    else if (impact) selected.push(impact.affects);
  }
  if (localDocker) {
    const engineIds = await readNativeDockerEffectEngines({ io: input.environmentIo, command: 'docker', prefix: [],
      cwd: input.userHomeDirectory, env, signal: input.signal });
    keys.push(...engineIds.map(dockerEndpoint => ({ kind: 'dockerEngine' as const, dockerEndpoint })));
  }
  if (selected.includes('dockerEngine')) keys.push(...await resolveMachineSetupImpactKeys(input, 'dockerEngine', env));
  const serviceIds = [...new Set(selected.flatMap(impact => typeof impact === 'object' ? impact.services : []))];
  if (serviceIds.length) keys.push(...await resolveMachineSetupImpactKeys(input, { services: serviceIds }, env));
  return keys;
}
