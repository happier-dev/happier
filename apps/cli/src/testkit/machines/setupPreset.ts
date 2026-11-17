import { hydrateManagedOpaqueSetupSourcesV1, projectManagedMachineSetupCreationSourcesV1,
  projectManagedOpaqueSetupSourcesV1 } from '@happier-dev/cli-common/machines/managed';
import { openManagedMachinePresetRecipientProjectionV1, projectManagedMachinePresetForRecipientV1,
  sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

/** Home carries a recipient projection; only the target holds its opened setup copy. */
export async function createPlainSetupPresetFixture(params: Readonly<{
  presetId: string; presetRevision: number; setup: MachineSetupV1;
}>) {
  const sealed = sealManagedMachinePresetContentV1({ presetId: params.presetId, mode: 'plain',
    content: { v: 1, name: params.presetId, setup: params.setup } });
  const sources = projectManagedMachineSetupCreationSourcesV1({ preset: { id: params.presetId,
    revision: params.presetRevision, contentEncryptionMode: 'plain' }, setup: params.setup });
  const source = sources[0];
  const direct = sources[1];
  if (!source || source.kind !== 'accountPresetOpaque' || !direct) throw new Error('Preset fixture must project its creation sources');
  const resolved = { ...source, presetContent: projectManagedMachinePresetForRecipientV1({ ...sealed,
    recipientAccountId: 'alice' }) };
  const opened = await hydrateManagedOpaqueSetupSourcesV1({ sources: [source, direct], resolvedSources: [resolved, direct],
    open: ({ presetId, projection }) => openManagedMachinePresetRecipientProjectionV1({ presetId, mode: 'plain', projection }) });
  if (!opened) throw new Error('Preset fixture must hydrate through the target source owner');
  const local = opened[0];
  if (!local || local.kind !== 'accountPreset') throw new Error('Preset fixture must open through the target source owner');
  const wire = projectManagedOpaqueSetupSourcesV1(opened)[0];
  if (!wire || wire.kind !== 'accountPresetOpaque') throw new Error('Preset fixture must project an opaque Action address');
  return { local, wire, resolved };
}
