import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import type { ManagedNativeOperationReferenceV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { splitMachineSetupForPreparationV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

type PreparationIdentity = Readonly<{ cliIdentity: string;
  credentialConfigurations: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'] }>;

export function createManagedMachinePresetPreparationBindingV1(params: PreparationIdentity & Readonly<{
  content: Pick<ManagedMachinePresetContentV1, 'setup' | 'authorEffectReview'> & {
    launch: NonNullable<ManagedMachinePresetContentV1['launch']>;
  };
  machineId?: string;
}>): ManagedMachinePresetPreparationBindingV1 {
  const { name: _name, ...launch } = params.content.launch;
  return { configuration: { launch, ...(params.content.setup === undefined ? {} : { setup: params.content.setup }),
      ...(params.content.authorEffectReview === undefined ? {} : {
        reviewedEffectDigest: params.content.authorEffectReview.reviewedEffectDigest,
      }) },
    cliIdentity: params.cliIdentity,
    ...(params.machineId === undefined ? {} : { machineId: params.machineId }),
    credentialConfigurations: params.credentialConfigurations };
}

type PreparedImage = Readonly<{ artifact: ManagedNativeOperationReferenceV1; binaryPath: string;
  bakedSetup?: MachineSetupV1; deferredSetup?: MachineSetupV1 }>;

export type ManagedMachinePresetPreparationDecisionV1 =
  | PreparedImage & Readonly<{ kind: 'warm'; updateCli?: true }>
  | PreparedImage & Readonly<{ kind: 'rebuild' }>
  | Readonly<{ kind: 'cold'; reason: 'disabled' | 'unprepared' | 'stale' | 'building' | 'failed' | 'cancelled' }>;

/** Image freshness follows authored configuration; CLI changes follow the author's update policy. */
export function readManagedMachinePresetPreparationV1(params: PreparationIdentity & Readonly<{
  content: ManagedMachinePresetContentV1;
  /** Consume the caller's canonical Manage decision; absence never authorizes a build. */
  canManagePreset?: boolean;
}>): ManagedMachinePresetPreparationDecisionV1 {
  const { content } = params;
  if (content.preparation?.enabled !== true) return { kind: 'cold', reason: 'disabled' };
  const prepared = content.prepared;
  if (prepared === undefined) return { kind: 'cold', reason: 'unprepared' };
  if (content.launch === undefined || !sameStrictJsonValue({ configuration: prepared.binding.configuration,
    credentialConfigurations: prepared.binding.credentialConfigurations },
    { configuration: createManagedMachinePresetPreparationBindingV1({ ...params,
      content: { ...content, launch: content.launch } }).configuration,
      credentialConfigurations: params.credentialConfigurations },
    { omitUndefinedObjectMembers: true })) return { kind: 'cold', reason: 'stale' };
  if (prepared.status !== 'ready') return { kind: 'cold', reason: prepared.status };
  if (prepared.cliBinaryPath === undefined) return { kind: 'cold', reason: 'unprepared' };
  const deferredSetup = content.setup === undefined ? undefined
    : splitMachineSetupForPreparationV1(content.setup, prepared.bakedSetup?.items?.length ?? 0).deferredSetup;
  // The private schema establishes that ready always has an artifact.
  const image = { artifact: prepared.artifact!, binaryPath: prepared.cliBinaryPath,
    ...(prepared.bakedSetup === undefined ? {} : { bakedSetup: prepared.bakedSetup }),
    ...(deferredSetup === undefined ? {} : { deferredSetup }) };
  const cliChanged = prepared.binding.cliIdentity !== params.cliIdentity;
  if (cliChanged && content.preparation.whenHappierUpdates === 'rebuild-automatically' && params.canManagePreset === true) {
    return { kind: 'rebuild', ...image };
  }
  return { kind: 'warm', ...image, ...(cliChanged ? { updateCli: true } : {}) };
}
