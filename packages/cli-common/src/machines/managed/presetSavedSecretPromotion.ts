import {
  SavedSecretOpaquePresetReferencesV1Schema,
  SavedSecretOpaquePresetRewritesV1Schema,
  type SavedSecretOpaquePresetReferencesV1,
  type SavedSecretOpaquePresetRewritesV1,
} from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import {
  isManagedOpaquePresetReadV1,
  type ManagedMachineReadV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import {
  createManagedMachinePresetSavedSecretReferenceRewriteV1,
  projectManagedMachinePresetForRecipientV1,
  rewriteManagedMachinePresetSavedSecretReferencesV1,
  sealManagedMachinePresetContentV1,
  type ManagedMachinePresetContentV1,
  type ManagedMachinePresetRecipientProjectionV1,
  type ManagedMachinePresetSavedSecretReferenceRewriteV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import {
  type ManagedMachinePresetRecipientCensusInputV1,
  type ManagedMachinePresetRecipientCensusResultV1,
  type ManagedMachinePresetV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Home transport and captured Account custody stay with the concrete UI/CLI host. */
export type ManagedMachinePresetSavedSecretReferenceReaderV1 = Readonly<{
  listPresets(cursor?: string): Promise<Readonly<{
    presets: readonly ManagedMachinePresetV1[];
    cursor?: string;
  }> | null>;
  /** The capture contract is exactly one active and one archived Home list. */
  listManaged(archived: boolean): Promise<readonly ManagedMachineReadV1[] | null>;
}>;

export type ManagedMachinePresetSavedSecretPromotionReaderV1 = ManagedMachinePresetSavedSecretReferenceReaderV1 & Readonly<{
  accountId: string;
  readRecipientCensus(input: ManagedMachinePresetRecipientCensusInputV1): Promise<ManagedMachinePresetRecipientCensusResultV1 | null>;
  /** Opens only one exact caller-relative projection at the already-captured key boundary. */
  open(input: Readonly<{
    presetId: string;
    mode: 'plain' | 'e2ee';
    projection: ManagedMachinePresetRecipientProjectionV1;
  }>): ManagedMachinePresetContentV1 | null | Promise<ManagedMachinePresetContentV1 | null>;
  /** The helper never retains a key; the caller owns copied-key disposal/currentness. */
  withE2eeAccountKey<TResult>(operation: (key: Readonly<{
    accountId: string;
    accountKey: Uint8Array;
  }>) => TResult): TResult | null | Promise<TResult | null>;
}>;

export type ManagedMachinePresetSavedSecretPromotionCaptureV1 =
  | Readonly<{
      kind: 'ready';
      opaquePresetReferences: SavedSecretOpaquePresetReferencesV1;
      rewrites: SavedSecretOpaquePresetRewritesV1;
    }>
  | Readonly<{ kind: 'unavailable' }>;

export type ManagedMachinePresetSavedSecretReferenceCaptureV1 =
  | Readonly<{ kind: 'ready'; opaquePresetReferences: SavedSecretOpaquePresetReferencesV1 }>
  | Readonly<{ kind: 'unavailable'; failure?: Readonly<{
      code: 'recipient_envelope_missing' | 'content_unavailable';
      context: Readonly<{ presetId: string; managedId?: string }>;
    }> }>;

function unavailable(): ManagedMachinePresetSavedSecretPromotionCaptureV1 {
  return { kind: 'unavailable' };
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function unreadableSecretReference(input: Readonly<{
  presetId: string;
  managedId?: string;
  projection: ManagedMachinePresetRecipientProjectionV1 | null;
}>): ManagedMachinePresetSavedSecretReferenceCaptureV1 {
  return { kind: 'unavailable', failure: {
    code: input.projection?.content.t === 'encrypted' && input.projection.recipientEnvelope === null
      ? 'recipient_envelope_missing' : 'content_unavailable',
    context: { presetId: input.presetId, ...(input.managedId ? { managedId: input.managedId } : {}) },
  } };
}

type SavedSecretPromotionInventoryV1 = Readonly<{
  presets: readonly ManagedMachinePresetV1[];
  activeRows: readonly ManagedMachineReadV1[];
  archivedRows: readonly ManagedMachineReadV1[];
  opaquePresetReferences: SavedSecretOpaquePresetReferencesV1;
}>;

/**
 * One current-Home raw inventory proves the opaque records covered by source
 * deletion. It deliberately never opens private content or requests key data.
 */
async function captureSavedSecretPromotionInventoryV1(params: Readonly<{
  homeId: string;
  reader: ManagedMachinePresetSavedSecretReferenceReaderV1;
  signal?: AbortSignal;
}>): Promise<SavedSecretPromotionInventoryV1 | null> {
  const presets: ManagedMachinePresetV1[] = [];
  const presetIds = new Set<string>();
  let cursor: string | undefined;
  do {
    throwIfAborted(params.signal);
    const page = await params.reader.listPresets(cursor);
    throwIfAborted(params.signal);
    if (page === null) return null;
    for (const preset of page.presets) {
      if (preset.homeId !== params.homeId || presetIds.has(preset.id)) return null;
      presetIds.add(preset.id);
      presets.push(preset);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);

  throwIfAborted(params.signal);
  const [activeRows, archivedRows] = await Promise.all([
    params.reader.listManaged(false),
    params.reader.listManaged(true),
  ]);
  throwIfAborted(params.signal);
  if (activeRows === null || archivedRows === null) return null;

  const snapshots: SavedSecretOpaquePresetReferencesV1['snapshots'] = [];
  const managedIds = new Set<string>();
  for (const read of [...activeRows, ...archivedRows]) {
    if (!isManagedOpaquePresetReadV1(read)) continue;
    const { machine } = read;
    if (machine.homeId !== params.homeId || managedIds.has(machine.id)) return null;
    managedIds.add(machine.id);
    snapshots.push({ managedId: machine.id, presetId: machine.preset.id });
  }
  const references = SavedSecretOpaquePresetReferencesV1Schema.safeParse({
    presets: presets.map(preset => ({ presetId: preset.id })),
    snapshots,
  });
  return references.success ? { presets, activeRows, archivedRows, opaquePresetReferences: references.data } : null;
}

/** Classify delete references at the keyholding caller; Home cannot inspect sealed bodies. */
export async function captureManagedMachinePresetSavedSecretReferencesV1(params: Readonly<{
  homeId: string;
  resourceRef: string;
  reader: Pick<ManagedMachinePresetSavedSecretPromotionReaderV1, 'accountId' | 'listPresets' | 'listManaged' | 'open'>;
  signal?: AbortSignal;
}>): Promise<ManagedMachinePresetSavedSecretReferenceCaptureV1> {
  const inventory = await captureSavedSecretPromotionInventoryV1(params);
  if (!inventory) return unavailable();
  const references: SavedSecretOpaquePresetReferencesV1 = { presets: [], snapshots: [] };
  const usesSecret = (content: ManagedMachinePresetContentV1) =>
    Object.values(content.setup?.secretRefs?.bindings ?? {}).some(binding => binding.ref === params.resourceRef);
  for (const preset of inventory.presets) {
    const projection = projectSourcePreset(preset, params.reader.accountId);
    if (!projection) return unreadableSecretReference({ presetId: preset.id, projection });
    const content = await params.reader.open({ presetId: preset.id, mode: preset.contentEncryptionMode, projection });
    throwIfAborted(params.signal);
    if (!content) return unreadableSecretReference({ presetId: preset.id, projection });
    if (usesSecret(content)) references.presets.push({ presetId: preset.id });
  }
  for (const read of [...inventory.activeRows, ...inventory.archivedRows]) {
    if (!isManagedOpaquePresetReadV1(read)) continue;
    const content = await params.reader.open({ presetId: read.machine.preset.id,
      mode: read.machine.preset.contentEncryptionMode, projection: read.presetContent });
    throwIfAborted(params.signal);
    if (!content) return unreadableSecretReference({ presetId: read.machine.preset.id,
      managedId: read.machine.id, projection: read.presetContent });
    if (usesSecret(content)) references.snapshots.push({ managedId: read.machine.id, presetId: read.machine.preset.id });
  }
  return { kind: 'ready', opaquePresetReferences: references };
}

function recipientCensusInput(preset: ManagedMachinePresetV1): ManagedMachinePresetRecipientCensusInputV1 {
  return {
    homeId: preset.homeId,
    presetId: preset.id,
    owner: preset.owner,
    ...(preset.controller === undefined ? {} : { controller: preset.controller }),
    ...(preset.controllerPoolId === undefined ? {} : { controllerPoolId: preset.controllerPoolId }),
  };
}

function projectSourcePreset(preset: ManagedMachinePresetV1, accountId: string): ManagedMachinePresetRecipientProjectionV1 | null {
  try {
    return projectManagedMachinePresetForRecipientV1({
      content: preset.content,
      recipients: preset.recipients,
      recipientAccountId: accountId,
    });
  } catch {
    return null;
  }
}

function rewriteContent(content: ManagedMachinePresetContentV1,
  rewrites: readonly ManagedMachinePresetSavedSecretReferenceRewriteV1[]): ManagedMachinePresetContentV1 | null {
  try {
    return rewriteManagedMachinePresetSavedSecretReferencesV1({ content, rewrites });
  } catch {
    return null;
  }
}

/**
 * Captures every visible saved-Preset body for one Home before personal Saved
 * Secret promotion. Changed source Presets fresh-seal with a current census;
 * retained snapshots preserve their exact DEK/caller-relative CAS carrier.
 * A missing body makes the entire promotion unavailable, never partial.
 */
export async function prepareManagedMachinePresetSavedSecretPromotionRewritesV1(params: Readonly<{
  homeId: string;
  rewrites: readonly ManagedMachinePresetSavedSecretReferenceRewriteV1[];
  reader: ManagedMachinePresetSavedSecretPromotionReaderV1;
  randomBytes: (length: number) => Uint8Array;
  signal?: AbortSignal;
}>): Promise<ManagedMachinePresetSavedSecretPromotionCaptureV1> {
  const inventory = await captureSavedSecretPromotionInventoryV1(params);
  if (!inventory) return unavailable();
  const { presets, activeRows, archivedRows, opaquePresetReferences } = inventory;

  const sourceRewrites: SavedSecretOpaquePresetRewritesV1['presets'] = [];
  for (const preset of presets) {
    const projection = projectSourcePreset(preset, params.reader.accountId);
    if (projection === null) return unavailable();
    throwIfAborted(params.signal);
    const opened = await params.reader.open({ presetId: preset.id, mode: preset.contentEncryptionMode, projection });
    throwIfAborted(params.signal);
    if (opened === null) return unavailable();
    const rewritten = rewriteContent(opened, params.rewrites);
    if (rewritten === null) return unavailable();
    if (sameStrictJsonValue(opened, rewritten)) continue;

    const census = await params.reader.readRecipientCensus(recipientCensusInput(preset));
    throwIfAborted(params.signal);
    if (census?.kind !== 'ready' || census.contentEncryptionMode !== preset.contentEncryptionMode) return unavailable();
    try {
      const replacement = preset.contentEncryptionMode === 'plain'
        ? sealManagedMachinePresetContentV1({ presetId: preset.id, mode: 'plain', content: rewritten })
        : sealManagedMachinePresetContentV1({ presetId: preset.id, mode: 'e2ee', content: rewritten,
          recipientCensus: census.recipients, randomBytes: params.randomBytes });
      sourceRewrites.push({ presetId: preset.id, expectedRevision: preset.revision,
        replacement: { content: replacement.content, recipients: [...replacement.recipients] } });
    } catch {
      return unavailable();
    }
  }

  const snapshotRewrites: SavedSecretOpaquePresetRewritesV1['snapshots'] = [];
  for (const read of [...activeRows, ...archivedRows]) {
    if (!isManagedOpaquePresetReadV1(read)) continue;
    const { machine, presetContent } = read;
    const mode = machine.preset.contentEncryptionMode;
    throwIfAborted(params.signal);
    const opened = await params.reader.open({ presetId: machine.preset.id, mode, projection: presetContent });
    throwIfAborted(params.signal);
    if (opened === null) return unavailable();
    const rewritten = rewriteContent(opened, params.rewrites);
    if (rewritten === null) return unavailable();
    if (sameStrictJsonValue(opened, rewritten)) continue;

    const replacement = mode === 'plain'
      ? createManagedMachinePresetSavedSecretReferenceRewriteV1({ presetId: machine.preset.id,
        mode: 'plain', projection: presetContent, rewrites: params.rewrites })
      : await params.reader.withE2eeAccountKey(key => {
        try {
          return createManagedMachinePresetSavedSecretReferenceRewriteV1({ presetId: machine.preset.id,
            mode: 'e2ee', projection: presetContent, rewrites: params.rewrites,
            accountId: key.accountId, accountKey: key.accountKey, randomBytes: params.randomBytes });
        } catch {
          return null;
        }
      });
    throwIfAborted(params.signal);
    if (replacement === null) return unavailable();
    snapshotRewrites.push({
      managedId: machine.id,
      presetId: machine.preset.id,
      expectedContentEncryptionMode: mode,
      expectedContent: presetContent.content,
      expectedRecipientEnvelope: presetContent.recipientEnvelope,
      replacementContent: replacement.content,
    });
  }

  const rewrites = SavedSecretOpaquePresetRewritesV1Schema.safeParse({
    presets: sourceRewrites,
    snapshots: snapshotRewrites,
  });
  return rewrites.success
    ? { kind: 'ready', opaquePresetReferences, rewrites: rewrites.data }
    : unavailable();
}
