import { z } from '../../zodRuntimePolicy.js';
import { ManagedMachinePresetRevisionInputV1Schema } from './managedMachinePresetRevisionV1.js';
export { ManagedMachinePresetRevisionInputV1Schema } from './managedMachinePresetRevisionV1.js';
import * as mini from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ManagedRefusalCodeV1Schema } from './providerFactsV1.js';
import { ManagedControllerV1Schema, ManagedControllerAccessV1Schema, ReusableRetentionV1Schema } from './managedMachineV1.js';
import { MachinePoolIdV1Schema } from '../pools/v1.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
import {
  SavedSecretResourceEnvelopeCensusRecipientV1Schema,
  SavedSecretResourceRecipientEnvelopeV1Schema,
} from '../../account/settings/savedSecretCatalogV1.js';
import {
  ManagedMachinePresetStoredContentCarrierV1Schema,
  createManagedMachinePresetStoredContentV1Schema,
  ManagedMachinePresetRecipientsV1Schema,
} from './managedMachinePresetContentV1.js';
export { MachineSetupV1Schema, MachineSetupV1ReadSchema, MachineSetupScriptV1Schema, mergeMachineSetupsV1, type MachineSetupV1, type MachineSetupScriptV1 } from './machineSetupV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());

/** Existing Account-change routing for saved preset content, including newly created records. */
export const MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'machine-presets' as const;

export const ManagedMachinePresetOwnerV1Schema = lazyZodSchema(() => z.union([
  AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
]));
export const ManagedMachinePresetLimitV1Schema = lazyZodSchema(() => z.strictObject({ maximum: z.number().check(z.int(), z.positive()) }));
/** Server computes the current Team audience/readiness; an existing preset binds mode to its stored author. */
export const ManagedMachinePresetRecipientCensusInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    homeId: id(), presetId: z.optional(id()),
    owner: ManagedMachinePresetOwnerV1Schema,
    controller: z.optional(ManagedControllerV1Schema),
    controllerPoolId: z.optional(MachinePoolIdV1Schema),
  }),
  /** The retained snapshot's custodian rewraps its independent content key. */
  z.strictObject({ homeId: id(), managedId: id() }),
]));
export type ManagedMachinePresetRecipientCensusInputV1 = z.infer<
  typeof ManagedMachinePresetRecipientCensusInputV1Schema
>;
export const ManagedMachinePresetRecipientCensusResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ready'),
    contentEncryptionMode: AccountEncryptionModeSchema,
    recipients: z.array(SavedSecretResourceEnvelopeCensusRecipientV1Schema),
  }),
  z.strictObject({ kind: z.literal('refused'), code: ManagedRefusalCodeV1Schema }),
]));
export type ManagedMachinePresetRecipientCensusResultV1 = z.infer<
  typeof ManagedMachinePresetRecipientCensusResultV1Schema
>;

/** One caller-relative envelope is enough to open a personally owned preset. */
function managedMachinePresetMigrationRecipientProjectionShape() {
  return {
    contentEncryptionMode: AccountEncryptionModeSchema,
    content: ManagedMachinePresetStoredContentCarrierV1Schema,
    recipientEnvelope: z.nullable(SavedSecretResourceRecipientEnvelopeV1Schema),
  };
}
function refineManagedMachinePresetMigrationRecipientProjection(
  value: Readonly<{ contentEncryptionMode: 'plain' | 'e2ee'; content: Readonly<{ t: 'plain' | 'encrypted' }>; recipientEnvelope: unknown | null }>,
  context: z.core.$RefinementCtx,
): void {
  if ((value.contentEncryptionMode === 'plain') !== (value.content.t === 'plain')) {
    context.addIssue({ code: 'custom', path: ['content'],
      message: 'Preset migration projection content must match its persisted mode' });
  }
  if ((value.contentEncryptionMode === 'plain') !== (value.recipientEnvelope === null)) {
    context.addIssue({ code: 'custom', path: ['recipientEnvelope'],
      message: 'Only E2EE preset migration content carries the owner envelope' });
  }
}
const ManagedMachinePresetMigrationReplacementV1Schema = lazyZodSchema(() => z.strictObject({
  content: ManagedMachinePresetStoredContentCarrierV1Schema,
  recipients: ManagedMachinePresetRecipientsV1Schema,
}));

const ManagedMachinePresetMigrationInventoryPresetV1Schema = lazyZodSchema(() => z.strictObject({
  presetId: id(),
  expectedRevision: revision(),
  ...managedMachinePresetMigrationRecipientProjectionShape(),
}).check(z.superRefine(refineManagedMachinePresetMigrationRecipientProjection)));

const ManagedMachinePresetMigrationInventorySnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: id(),
  presetId: id(),
  ...managedMachinePresetMigrationRecipientProjectionShape(),
}).check(z.superRefine(refineManagedMachinePresetMigrationRecipientProjection)));

/**
 * Captured server inventory for one Account's personally owned preset bodies
 * and the independently persisted admitted snapshots which reference them.
 * Team-owned source presets intentionally do not enter an Account-mode flip.
 */
export const ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema = lazyZodSchema(() => z.strictObject({
  presets: z.array(ManagedMachinePresetMigrationInventoryPresetV1Schema),
  snapshots: z.array(ManagedMachinePresetMigrationInventorySnapshotV1Schema),
}).check(z.superRefine((value, context) => {
  const presetIds = new Set<string>();
  value.presets.forEach((preset, index) => {
    if (presetIds.has(preset.presetId)) {
      context.addIssue({ code: 'custom', path: ['presets', index, 'presetId'],
        message: 'Account migration cannot inventory the same managed preset twice' });
    }
    presetIds.add(preset.presetId);
  });
  const managedIds = new Set<string>();
  value.snapshots.forEach((snapshot, index) => {
    if (managedIds.has(snapshot.managedId)) {
      context.addIssue({ code: 'custom', path: ['snapshots', index, 'managedId'],
        message: 'Account migration cannot inventory the same retained managed snapshot twice' });
    }
    managedIds.add(snapshot.managedId);
    if (!presetIds.has(snapshot.presetId)) {
      context.addIssue({ code: 'custom', path: ['snapshots', index, 'presetId'],
        message: 'A retained managed snapshot must belong to an inventoried personal preset' });
    }
  });
})));
export type ManagedMachinePresetAccountEncryptionMigrationInventoryV1 = Readonly<
  z.infer<typeof ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema>
>;

/**
 * Exact source-revision and retained-snapshot replacements for the Account
 * transition transaction. Snapshot content has no revision: controller reports
 * replace it without incrementing intentRevision, so the captured opaque tuple
 * itself is the currentness fence.
 */
export const AccountEncryptionMigrateManagedMachinePresetsDirectiveV1Schema = lazyZodSchema(() => z.strictObject({
  presets: z.array(z.strictObject({
    presetId: id(),
    expectedRevision: revision(),
    replacement: ManagedMachinePresetMigrationReplacementV1Schema,
  })),
  snapshots: z.array(z.strictObject({
    managedId: id(),
    presetId: id(),
    expectedContentEncryptionMode: AccountEncryptionModeSchema,
    expectedContent: ManagedMachinePresetStoredContentCarrierV1Schema,
    expectedRecipientEnvelope: z.nullable(SavedSecretResourceRecipientEnvelopeV1Schema),
    replacement: ManagedMachinePresetMigrationReplacementV1Schema,
  })),
}).check(z.superRefine((value, context) => {
  const presetIds = new Set<string>();
  value.presets.forEach((preset, index) => {
    if (presetIds.has(preset.presetId)) {
      context.addIssue({ code: 'custom', path: ['presets', index, 'presetId'],
        message: 'Account migration cannot replace the same managed preset twice' });
    }
    presetIds.add(preset.presetId);
  });
  const managedIds = new Set<string>();
  value.snapshots.forEach((snapshot, index) => {
    if (managedIds.has(snapshot.managedId)) {
      context.addIssue({ code: 'custom', path: ['snapshots', index, 'managedId'],
        message: 'Account migration cannot replace the same retained managed snapshot twice' });
    }
    managedIds.add(snapshot.managedId);
    if (!presetIds.has(snapshot.presetId)) {
      context.addIssue({ code: 'custom', path: ['snapshots', index, 'presetId'],
        message: 'A retained managed snapshot replacement requires its source preset replacement' });
    }
    const expectedPlain = snapshot.expectedContentEncryptionMode === 'plain';
    if (expectedPlain !== (snapshot.expectedContent.t === 'plain')) {
      context.addIssue({ code: 'custom', path: ['snapshots', index, 'expectedContent'],
        message: 'Retained managed snapshot content must match its persisted mode' });
    }
    if (expectedPlain !== (snapshot.expectedRecipientEnvelope === null)) {
      context.addIssue({ code: 'custom', path: ['snapshots', index, 'expectedRecipientEnvelope'],
        message: 'Only an E2EE retained snapshot carries the owner envelope' });
    }
  });
})));
export type AccountEncryptionMigrateManagedMachinePresetsDirectiveV1 = Readonly<
  z.infer<typeof AccountEncryptionMigrateManagedMachinePresetsDirectiveV1Schema>
>;
/** Structural fields only; semantic creation/delegation checks belong to the refined schema below. */
export function createManagedMachinePresetV1BaseShape<Choices extends z.core.$ZodType>(_choices: Choices) {
  return {
    id: id(), homeId: id(), revision: revision(),
    /** Client-maintained launch/setup change counter; absent legacy rows mean zero. */
    configurationRevision: z.optional(revision()),
    owner: ManagedMachinePresetOwnerV1Schema,
    /** Persisted owner mode: readers must never substitute the viewer's Account mode. */
    contentEncryptionMode: AccountEncryptionModeSchema,
    content: ManagedMachinePresetStoredContentCarrierV1Schema,
    recipients: ManagedMachinePresetRecipientsV1Schema,
    controller: z.optional(ManagedControllerV1Schema),
    controllerPoolId: z.optional(MachinePoolIdV1Schema),
    retention: mini.optional(ReusableRetentionV1Schema),
    wakeOnAcceptedMessage: z.optional(z.boolean()),
    /** Explicit opt-in; visibility alone never grants Team acquire authority. */
    teamAcquireDelegated: z.optional(z.boolean()),
    simultaneousLimit: z.optional(ManagedMachinePresetLimitV1Schema),
    archivedAt: z.optional(z.number().check(z.nonnegative())),
  };
}

/** Unrefined structural schema for owner-local persistence/projection code. */
export function createManagedMachinePresetV1BaseSchema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject(createManagedMachinePresetV1BaseShape(choices));
}

/** Preset persistence is opaque: refine only its mode tag and public structural relationships. */
function hasValidPresetParts(preset: { controller?: unknown; controllerPoolId?: unknown;
  content?: unknown; contentEncryptionMode?: unknown; teamAcquireDelegated?: boolean }): boolean {
  const content = preset.content;
  if (content === undefined || typeof content !== 'object' || content === null || !('t' in content)) return false;
  const tag = (content as { t?: unknown }).t;
  if ((tag === 'plain' && preset.contentEncryptionMode !== 'plain')
    || (tag === 'encrypted' && preset.contentEncryptionMode !== 'e2ee')) return false;
  return (!(preset.controller !== undefined && preset.controllerPoolId !== undefined))
    && (!preset.teamAcquireDelegated
      || preset.controller !== undefined || preset.controllerPoolId !== undefined);
}

export function createManagedMachinePresetV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return createManagedMachinePresetV1BaseSchema(choices).check(z.refine(hasValidPresetParts,
    { message: 'A Preset requires complete creation or setup.' }));
}

/**
 * Client-side persisted reader composes the private-content reader for legacy
 * normalization. Server storage/admission uses the opaque base/refined schemas above.
 */
function createManagedMachinePresetV1ReadSchema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    ...createManagedMachinePresetV1BaseShape(choices),
    content: createStoredReadSchema(createManagedMachinePresetStoredContentV1Schema(choices)),
  }).check(z.refine(hasValidPresetParts, { message: 'A Preset requires complete creation or setup.' }));
}

/** Transport validates the envelope; save/use additionally validate the selected contribution. */
export const ManagedMachinePresetV1BaseSchema = lazyZodSchema(() =>
  createManagedMachinePresetV1BaseSchema(PluginJsonValueV2Schema));
export const ManagedMachinePresetV1Schema = lazyZodSchema(() => createManagedMachinePresetV1Schema(PluginJsonValueV2Schema));
export const ManagedMachinePresetV1ReadSchema = lazyZodSchema(() =>
  createManagedMachinePresetV1ReadSchema(PluginJsonValueV2Schema));
export type ManagedMachinePresetV1 = z.infer<typeof ManagedMachinePresetV1Schema>;
/** Exact acquisition routing is ephemeral; saved Presets never expose controller custody. */
export const MANAGED_PRESET_ACQUIRE_ROUTING_PATH_V1 = '/v1/machines/presets/resolve-acquire';
export const ManagedMachinePresetAcquireRoutingInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), id: id(), revision: revision(), controller: ManagedControllerV1Schema,
}));
export type ManagedMachinePresetAcquireRoutingInputV1 = z.infer<typeof ManagedMachinePresetAcquireRoutingInputV1Schema>;
export const ManagedMachinePresetAcquireRoutingResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('resolved'), controller: ManagedControllerV1Schema, controllerAccess: ManagedControllerAccessV1Schema }),
  z.strictObject({ kind: z.literal('refused'), code: ManagedRefusalCodeV1Schema }),
]));
export type ManagedMachinePresetAcquireRoutingResultV1 = z.infer<typeof ManagedMachinePresetAcquireRoutingResultV1Schema>;

/** Structural selection retained by the initiating host until controller/Pool binding. */
export type ManagedMachinePresetAcquireOriginV1 = Pick<ManagedMachinePresetV1,
  'id' | 'homeId' | 'revision' | 'controller' | 'controllerPoolId' | 'retention' | 'wakeOnAcceptedMessage'>;

export const ManagedMachinePresetCreateInputV1Schema = lazyZodSchema(() => z.omit(
  createManagedMachinePresetV1BaseSchema(PluginJsonValueV2Schema), { revision: true, archivedAt: true },
).check(z.refine(hasValidPresetParts, { message: 'A Preset requires complete creation or setup.' })));
export const ManagedMachinePresetGetInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), id: id() }));
export const ManagedMachinePresetListInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), owner: z.optional(ManagedMachinePresetOwnerV1Schema),
  includeArchived: z.optional(z.boolean()), cursor: z.optional(id()),
}));
export const ManagedMachinePresetUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), id: id(), expectedRevision: revision(),
  patch: z.strictObject({
    configurationRevision: z.optional(revision()),
    contentEncryptionMode: z.optional(AccountEncryptionModeSchema),
    content: mini.optional(mini.nullable(ManagedMachinePresetStoredContentCarrierV1Schema)),
    recipients: mini.optional(ManagedMachinePresetRecipientsV1Schema),
    controller: mini.optional(mini.nullable(ManagedControllerV1Schema)),
    controllerPoolId: mini.optional(mini.nullable(MachinePoolIdV1Schema)),
    retention: mini.optional(mini.nullable(ReusableRetentionV1Schema)),
    wakeOnAcceptedMessage: z.optional(z.nullable(z.boolean())),
    teamAcquireDelegated: z.optional(z.boolean()),
    simultaneousLimit: z.optional(z.nullable(ManagedMachinePresetLimitV1Schema)),
  }),
}));
export { ManagedRefusalCodeV1Schema as ManagedMachinePresetRefusalCodeV1Schema } from './providerFactsV1.js';
export const ManagedMachinePresetRefusedV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('refused'), code: ManagedRefusalCodeV1Schema,
}));
export const PresetMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), preset: ManagedMachinePresetV1Schema }),
  z.strictObject({ kind: z.literal('conflict'), currentRevision: revision() }),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetGetResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('found'), preset: ManagedMachinePresetV1Schema }),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetListResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('listed'), presets: z.array(ManagedMachinePresetV1Schema), cursor: z.optional(id()) }),
  ManagedMachinePresetRefusedV1Schema,
]));
export type ManagedMachinePresetCreateInputV1 = z.infer<typeof ManagedMachinePresetCreateInputV1Schema>;
export type ManagedMachinePresetUpdateInputV1 = z.infer<typeof ManagedMachinePresetUpdateInputV1Schema>;
export type ManagedMachinePresetGetInputV1 = z.infer<typeof ManagedMachinePresetGetInputV1Schema>;
export type ManagedMachinePresetListInputV1 = z.infer<typeof ManagedMachinePresetListInputV1Schema>;
export type ManagedMachinePresetRevisionInputV1 = z.infer<typeof ManagedMachinePresetRevisionInputV1Schema>;
export type PresetMutationResultV1 = z.infer<typeof PresetMutationResultV1Schema>;
export type ManagedMachinePresetGetResultV1 = z.infer<typeof ManagedMachinePresetGetResultV1Schema>;
export type ManagedMachinePresetListResultV1 = z.infer<typeof ManagedMachinePresetListResultV1Schema>;
