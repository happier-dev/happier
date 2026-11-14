import { MachineSetupSourceApplyV1Schema, type MachineSetupResolvedOpaquePresetSourceV1,
  type MachineSetupResolvedSourceV1, type MachineSetupSourceApplyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetContentV1Schema, type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { readManagedMachinePresetContentOverrideForModeV1,
  resolveManagedMachinePresetSetupOverrideV1,
  type ManagedMachinePresetRecipientProjectionV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachineSetupSourceEntryV1Schema, MachineSetupSourceV1Schema,
  type MachineSetupSourceEntryV1, type MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** The keyholding runtime opens only the exact recipient projection selected by Home. */
export type ManagedOpaqueSetupSourceOpenerV1 = (source: Readonly<{
  presetId: string;
  mode: 'plain' | 'e2ee';
  projection: ManagedMachinePresetRecipientProjectionV1;
}>) =>
  ManagedMachinePresetContentV1 | null | Promise<ManagedMachinePresetContentV1 | null>;

export type ManagedOpaqueSetupSourcePresentationV1 =
  | Readonly<{ kind: 'opened'; source: MachineSetupSourceEntryV1; presetName?: string }>
  | Readonly<{ kind: 'unavailable'; source: MachineSetupSourceApplyV1[number] }>;

type ManagedOpaqueSetupSourceHydrationParamsV1 = Readonly<{
  sources: MachineSetupSourceApplyV1;
  resolvedSources: MachineSetupResolvedSourceV1;
  open: ManagedOpaqueSetupSourceOpenerV1;
}>;

function sameOpaqueReference(left: Extract<MachineSetupSourceApplyV1[number], { kind: 'accountPresetOpaque' }>,
  right: MachineSetupResolvedOpaquePresetSourceV1): boolean {
  return left.presetId === right.presetId && left.presetRevision === right.presetRevision
    && left.contentEncryptionMode === right.contentEncryptionMode
    && sameStrictJsonValue(left.presetContentOverride ?? null, right.presetContentOverride ?? null);
}

function parseLocalSource(value: unknown): MachineSetupSourceEntryV1 | null {
  const parsed = MachineSetupSourceEntryV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function hydrateManagedOpaqueSetupSourceV1(params: ManagedOpaqueSetupSourceHydrationParamsV1,
  source: MachineSetupSourceApplyV1[number], resolved: MachineSetupResolvedSourceV1[number] | undefined): Promise<Readonly<{
    source: MachineSetupSourceEntryV1;
    presetName?: string;
  }> | null> {
  if (resolved === undefined) return null;
  if (source.kind !== 'accountPresetOpaque') {
    const local = sameStrictJsonValue(source, resolved) ? parseLocalSource(source) : null;
    return local === null ? null : { source: local };
  }
  if (resolved.kind !== 'accountPresetOpaque' || !sameOpaqueReference(source, resolved)) return null;
  const opened = ManagedMachinePresetContentV1Schema.safeParse(await params.open({ presetId: resolved.presetId,
    mode: resolved.contentEncryptionMode, projection: resolved.presetContent }));
  if (!opened.success) return null;
  const override = resolved.presetContentOverride === undefined ? undefined
    : readManagedMachinePresetContentOverrideForModeV1({ mode: resolved.contentEncryptionMode,
      override: resolved.presetContentOverride });
  if (override === null) return null;
  const openedOverride = override === undefined ? undefined : ManagedMachinePresetContentV1Schema.safeParse(await params.open({
    presetId: resolved.presetId, mode: resolved.contentEncryptionMode,
    projection: { ...resolved.presetContent, content: override.content },
  }));
  if (openedOverride !== undefined && !openedOverride.success) return null;
  const setup = openedOverride === undefined ? opened.data.setup ?? {}
    : resolveManagedMachinePresetSetupOverrideV1({ baseContent: opened.data, overrideContent: openedOverride.data });
  if (setup === null) return null;
  const local = parseLocalSource({ kind: 'accountPreset', presetId: source.presetId, presetRevision: source.presetRevision,
    contentEncryptionMode: source.contentEncryptionMode, ...(override === undefined ? {} : { presetContentOverride: override }), setup });
  return local === null ? null : { source: local, presetName: opened.data.name };
}

/**
 * Opens each independently addressed source at the keyholder boundary. This
 * presentation form isolates an unavailable Team envelope without replacing a
 * historical attachment with a newer preset read.
 */
export async function hydrateManagedOpaqueSetupSourcePresentationsV1(params: ManagedOpaqueSetupSourceHydrationParamsV1):
  Promise<readonly ManagedOpaqueSetupSourcePresentationV1[]> {
  if (params.sources.length !== params.resolvedSources.length) {
    return params.sources.map(source => ({ kind: 'unavailable' as const, source }));
  }
  return await Promise.all(params.sources.map(async (source, index) => {
    const local = await hydrateManagedOpaqueSetupSourceV1(params, source, params.resolvedSources[index]);
    return local === null ? { kind: 'unavailable' as const, source } : { kind: 'opened' as const, ...local };
  }));
}

/**
 * Converts a Home Action's opaque setup references into daemon-local opened
 * copies. The source order is part of recipe-plan addressing, so Home cannot
 * reorder or substitute a resolved source without an explicit refusal.
 */
export async function hydrateManagedOpaqueSetupSourcesV1(params: Readonly<{
  sources: MachineSetupSourceApplyV1;
  resolvedSources: MachineSetupResolvedSourceV1;
  open: ManagedOpaqueSetupSourceOpenerV1;
}>): Promise<MachineSetupSourceV1 | null> {
  const presentation = await hydrateManagedOpaqueSetupSourcePresentationsV1(params);
  const local: MachineSetupSourceV1 = [];
  for (const entry of presentation) {
    if (entry.kind === 'unavailable') return null;
    local.push(entry.source);
  }
  const parsed = MachineSetupSourceV1Schema.safeParse(local);
  return parsed.success ? parsed.data : null;
}

/** Reprojects local opened copies for an Action response or the next signed Action input. */
export function projectManagedOpaqueSetupSourcesV1(sources: MachineSetupSourceV1): MachineSetupSourceApplyV1 {
  return MachineSetupSourceApplyV1Schema.parse(sources.map(source => source.kind === 'accountPreset'
    ? { kind: 'accountPresetOpaque' as const, presetId: source.presetId, presetRevision: source.presetRevision,
      contentEncryptionMode: source.contentEncryptionMode,
      ...(source.presetContentOverride === undefined ? {} : { presetContentOverride: source.presetContentOverride }) }
    : source));
}
