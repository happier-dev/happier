import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import type { ManagedNativeOperationReferenceV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { splitMachineSetupForPreparationV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

type PreparationIdentity = Readonly<{ presetRevision: number; cliIdentity: string;
  credentialConfigurations: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'] }>;

export function createManagedMachinePresetPreparationBindingV1(params: PreparationIdentity & Readonly<{
  content: Pick<ManagedMachinePresetContentV1, 'setup' | 'authorEffectReview'> & {
    launch: NonNullable<ManagedMachinePresetContentV1['launch']>;
  };
  machineId?: string;
}>): ManagedMachinePresetPreparationBindingV1 {
  const { name: _name, ...launch } = params.content.launch;
  return { presetRevision: params.presetRevision,
    configuration: { launch, ...(params.content.setup === undefined ? {} : { setup: params.content.setup }),
      ...(params.content.authorEffectReview === undefined ? {} : {
        reviewedEffectDigest: params.content.authorEffectReview.reviewedEffectDigest,
      }) },
    cliIdentity: params.cliIdentity,
    ...(params.machineId === undefined ? {} : { machineId: params.machineId }),
    credentialConfigurations: params.credentialConfigurations };
}

export type ManagedMachinePresetPreparationDecisionV1 =
  | Readonly<{ kind: 'warm'; artifact: ManagedNativeOperationReferenceV1; binaryPath: string;
    bakedSetup?: MachineSetupV1; deferredSetup?: MachineSetupV1 }>
  | Readonly<{ kind: 'cold'; reason: 'disabled' | 'unprepared' | 'stale' | 'building' | 'failed' | 'cancelled' }>;

/** One admission-time comparison of the exact persisted revision and supplier/configuration tuple. */
export function readManagedMachinePresetPreparationV1(params: PreparationIdentity & Readonly<{
  content: ManagedMachinePresetContentV1;
}>): ManagedMachinePresetPreparationDecisionV1 {
  const { content } = params;
  if (content.preparation?.enabled !== true) return { kind: 'cold', reason: 'disabled' };
  const prepared = content.prepared;
  if (prepared === undefined) return { kind: 'cold', reason: 'unprepared' };
  if (content.launch === undefined || !sameStrictJsonValue(prepared.binding,
    createManagedMachinePresetPreparationBindingV1({ ...params, content: { ...content, launch: content.launch },
      machineId: prepared.binding.machineId }),
    { omitUndefinedObjectMembers: true })) return { kind: 'cold', reason: 'stale' };
  if (prepared.status !== 'ready') return { kind: 'cold', reason: prepared.status };
  if (prepared.cliBinaryPath === undefined) return { kind: 'cold', reason: 'unprepared' };
  const deferredSetup = content.setup === undefined ? undefined
    : splitMachineSetupForPreparationV1(content.setup, prepared.bakedSetup?.items?.length ?? 0).deferredSetup;
  // The private schema establishes that ready always has an artifact.
  return { kind: 'warm', artifact: prepared.artifact!, binaryPath: prepared.cliBinaryPath,
    ...(prepared.bakedSetup === undefined ? {} : { bakedSetup: prepared.bakedSetup }),
    ...(deferredSetup === undefined ? {} : { deferredSetup }) };
}
