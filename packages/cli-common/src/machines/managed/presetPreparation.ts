import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import type { ManagedNativeOperationReferenceV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

type PreparationIdentity = Readonly<{ presetRevision: number; cliIdentity: string; credentialIdentity: string | null }>;

export function createManagedMachinePresetPreparationBindingV1(params: PreparationIdentity & Readonly<{
  content: Pick<ManagedMachinePresetContentV1, 'setup'> & {
    launch: NonNullable<ManagedMachinePresetContentV1['launch']>;
  };
}>): ManagedMachinePresetPreparationBindingV1 {
  const { name: _name, ...launch } = params.content.launch;
  return { presetRevision: params.presetRevision,
    configuration: { launch, ...(params.content.setup === undefined ? {} : { setup: params.content.setup }) },
    cliIdentity: params.cliIdentity, credentialIdentity: params.credentialIdentity };
}

export type ManagedMachinePresetPreparationDecisionV1 =
  | Readonly<{ kind: 'warm'; artifact: ManagedNativeOperationReferenceV1; bakedSetup?: MachineSetupV1 }>
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
    createManagedMachinePresetPreparationBindingV1({ ...params, content: { launch: content.launch, setup: content.setup } }),
    { omitUndefinedObjectMembers: true })) return { kind: 'cold', reason: 'stale' };
  if (prepared.status !== 'ready') return { kind: 'cold', reason: prepared.status };
  // The private schema establishes that ready always has an artifact.
  return { kind: 'warm', artifact: prepared.artifact!,
    ...(prepared.bakedSetup === undefined ? {} : { bakedSetup: prepared.bakedSetup }) };
}
