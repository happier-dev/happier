import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import type { ManagedNativeOperationReferenceV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { splitMachineSetupForPreparationV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

type PreparationIdentity = Readonly<{ cliIdentity: string;
  credentialConfigurations: ManagedMachinePresetPreparationBindingV1['credentialConfigurations'] }>;

type PreparationContent = Pick<ManagedMachinePresetContentV1, 'setup' | 'authorEffectReview'> & {
  launch: NonNullable<ManagedMachinePresetContentV1['launch']>;
};

function readPreparationConfiguration(content: PreparationContent): ManagedMachinePresetPreparationBindingV1['configuration'] {
  const { name: _name, ...launch } = content.launch;
  return { launch, ...(content.setup === undefined ? {} : { setup: content.setup }),
    ...(content.authorEffectReview === undefined ? {} : { reviewedEffectDigest: content.authorEffectReview.reviewedEffectDigest }) };
}

export function createManagedMachinePresetPreparationBindingV1(params: PreparationIdentity & Readonly<{
  content: PreparationContent;
  machineId?: string;
}>): ManagedMachinePresetPreparationBindingV1 {
  return { configuration: readPreparationConfiguration(params.content),
    cliIdentity: params.cliIdentity,
    ...(params.machineId === undefined ? {} : { machineId: params.machineId }),
    credentialConfigurations: params.credentialConfigurations };
}

type PreparedImage = Readonly<{ artifact: ManagedNativeOperationReferenceV1; binaryPath: string;
  bakedSetup?: MachineSetupV1; deferredSetup?: MachineSetupV1 }>;

type PreparedImageDecision = PreparedImage & (Readonly<{ kind: 'warm'; updateCli?: true }> | Readonly<{ kind: 'rebuild' }>);
type ColdDecision = Readonly<{ kind: 'cold'; reason: 'disabled' | 'unprepared' | 'stale' | 'building' | 'failed' | 'cancelled' }>;
export type ManagedMachinePresetPreparationDecisionV1 = PreparedImageDecision | ColdDecision;

type PreparationSelection = Pick<PreparationIdentity, 'credentialConfigurations'> & Readonly<{
  content: ManagedMachinePresetContentV1;
  /** Consume the caller's canonical Manage decision; absence never authorizes a build. */
  canManagePreset?: boolean;
}>;

type PreparedCandidate = Readonly<{ kind: 'candidate'; image: PreparedImage; boundCliIdentity: string; rebuildForCliChange: boolean }>;

function readPreparedCandidate(params: PreparationSelection): PreparedCandidate | ColdDecision {
  const { content } = params;
  if (content.preparation?.enabled !== true) return { kind: 'cold', reason: 'disabled' };
  const prepared = content.prepared;
  if (prepared === undefined) return { kind: 'cold', reason: 'unprepared' };
  if (content.launch === undefined || !sameStrictJsonValue({ configuration: prepared.binding.configuration,
    credentialConfigurations: prepared.binding.credentialConfigurations },
    { configuration: readPreparationConfiguration({ ...content, launch: content.launch }),
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
  return { kind: 'candidate', image, boundCliIdentity: prepared.binding.cliIdentity,
    rebuildForCliChange: content.preparation.whenHappierUpdates === 'rebuild-automatically' && params.canManagePreset === true };
}

function selectPreparedCli(candidate: PreparedCandidate, cliIdentity: string): PreparedImageDecision {
  const cliChanged = candidate.boundCliIdentity !== cliIdentity;
  if (cliChanged && candidate.rebuildForCliChange) return { kind: 'rebuild', ...candidate.image };
  return { kind: 'warm', ...candidate.image, ...(cliChanged ? { updateCli: true } : {}) };
}

/** Image freshness follows authored configuration; CLI changes follow the author's update policy. */
export function readManagedMachinePresetPreparationV1(params: PreparationSelection & Pick<PreparationIdentity, 'cliIdentity'>): ManagedMachinePresetPreparationDecisionV1 {
  const candidate = readPreparedCandidate(params);
  return candidate.kind === 'cold' ? candidate : selectPreparedCli(candidate, params.cliIdentity);
}

/** Resolve the supplier only when the saved configuration has an eligible image. */
export async function resolveManagedMachinePresetPreparationV1(params: PreparationSelection & Readonly<{
  readCliIdentity(): Promise<string>;
}>): Promise<ColdDecision | PreparedImageDecision & Readonly<{ cliIdentity: string }>> {
  const candidate = readPreparedCandidate(params);
  if (candidate.kind === 'cold') return candidate;
  const cliIdentity = await params.readCliIdentity();
  return { ...selectPreparedCli(candidate, cliIdentity), cliIdentity };
}
