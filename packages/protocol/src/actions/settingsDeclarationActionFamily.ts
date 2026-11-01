import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { QualifiedConnectedAccountPurposeBindingTargetV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { VoiceCredentialSlotIdSchema } from '../plugins/contributions/voiceProviders.js';
import { PersistedConnectedServiceBindingsV1Schema } from '../connect/connectedServiceBindings.js';

export const SETTINGS_DECLARATION_ACTION_IDS_V1 = ['settings.list', 'settings.get', 'settings.set', 'settings.reset', 'settings.invoke'] as const;
export type SettingsDeclarationActionIdV1 = typeof SETTINGS_DECLARATION_ACTION_IDS_V1[number];

export function isSettingsDeclarationActionIdV1(value: string): value is SettingsDeclarationActionIdV1 {
  return (SETTINGS_DECLARATION_ACTION_IDS_V1 as readonly string[]).includes(value);
}

/** Values are strict JSON; the declaration's canonical owner admits each setting's shape. */
export const SettingsDeclarationValueV1Schema = StrictJsonValueSchema;
const SettingsDeclarationScalarChoiceV1Schema = lazyZodSchema(() => z.union([z.string(), z.number(), z.boolean(), z.null()]));
const AnchorSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SettingKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const OperationIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const VoiceSavedSecretOperationBasisSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('voice_saved_secret'),
  credentialSlotId: VoiceCredentialSlotIdSchema,
  machineId: z.optional(z.nullable(OperationIdSchema)),
  expectedSettingsVersion: z.number().check(z.int(), z.nonnegative()),
  expectedSecretId: z.nullable(OperationIdSchema),
  expectedSecretUpdatedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
  expectedRecipientContractDigest: z.optional(z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/))),
}));
export const SettingsDeclarationTargetKindV1Schema = lazyZodSchema(() => z.enum(['home', 'team', 'team_identity_connection', 'project', 'public_profile_draft']));
/** Resource identity only; caller Account and authority come from Action admission. */
export const SettingsDeclarationTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home'), serverId: OperationIdSchema }),
  z.strictObject({ kind: z.literal('project'), serverId: OperationIdSchema, projectKey: OperationIdSchema }),
  // The answering host supplies the captured draft; callers name only its Home.
  z.strictObject({ kind: z.literal('public_profile_draft'), serverId: OperationIdSchema }),
  z.strictObject({ kind: z.literal('team'), serverId: OperationIdSchema, teamId: OperationIdSchema }),
  z.strictObject({ kind: z.literal('team_identity_connection'), serverId: OperationIdSchema, teamId: OperationIdSchema, connectionId: OperationIdSchema }),
]));
export type SettingsDeclarationTargetV1 = z.infer<typeof SettingsDeclarationTargetV1Schema>;
export type SettingsDeclarationTargetKindV1 = SettingsDeclarationTargetV1['kind'];
/** Exact operation targets, never a settings path, credential value or caller confirmation. */
export const SettingsDeclarationOperationInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('atmosphere_picture_add'), source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('picked') }),
    z.strictObject({ kind: z.literal('url'), url: z.url().check(z.refine(value => /^https?:\/\//i.test(value))) }),
    z.strictObject({ kind: z.literal('machine_file'), machineId: OperationIdSchema, path: OperationIdSchema }),
  ]) }),
  z.strictObject({ kind: z.literal('atmosphere_picture_remove'), localId: OperationIdSchema }),
  z.strictObject({ kind: z.literal('account_settings_history_purge'), versions: z.array(z.number().check(z.int(), z.nonnegative(), z.int())).check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('account_settings_history_restore'), historyVersion: z.number().check(z.int(), z.nonnegative()),
    expectedSettingsVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ kind: z.literal('account_encryption_mode_convert'), toMode: z.enum(['plain', 'e2ee']) }),
  z.strictObject({ kind: z.literal('model_pack'), packId: OperationIdSchema, machineId: z.optional(OperationIdSchema) }),
  z.strictObject({ kind: z.literal('voice_preview'), voiceId: OperationIdSchema }),
  z.strictObject({ kind: z.literal('voice_connected_services'),
    expectedSettingsVersion: z.number().check(z.int(), z.nonnegative()),
    value: z.nullable(PersistedConnectedServiceBindingsV1Schema),
  }),
  z.extend(VoiceSavedSecretOperationBasisSchema, { operation: z.literal('bind'), secretId: OperationIdSchema }),
  z.extend(VoiceSavedSecretOperationBasisSchema, { operation: z.enum(['inspect', 'remove', 'review']) }),
  z.strictObject({ kind: z.literal('voice_credential_source'), credentialSlotId: VoiceCredentialSlotIdSchema,
    expectedSettingsVersion: z.number().check(z.int(), z.nonnegative()),
    // A displayed declaration may fence its gesture; automated callers use the declaration captured at admission.
    expectedContractDigest: z.optional(z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/))),
    selection: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({ kind: z.literal('savedSecret') }),
      z.strictObject({ kind: z.literal('connectedAccount'), target: QualifiedConnectedAccountPurposeBindingTargetV1Schema }),
    ]),
  }),
  z.strictObject({ kind: z.literal('diagnostics_enabled'), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('diagnostics_export'), artifactId: OperationIdSchema, machineId: z.optional(OperationIdSchema) }),
  z.strictObject({ kind: z.literal('diagnostics_session'), sessionId: OperationIdSchema, machineId: OperationIdSchema }),
  z.strictObject({ kind: z.literal('diagnostics_revocation'), key: OperationIdSchema, revision: z.number().check(z.int(), z.positive(), z.int()) }),
]));
export type SettingsDeclarationOperationInputV1 = z.infer<typeof SettingsDeclarationOperationInputV1Schema>;
export const SettingsDeclarationDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  anchor: AnchorSchema,
  pageId: z.string().check(z.minLength(1)),
  title: z.string(),
  description: z.optional(z.string()),
  readable: z.boolean(),
  writable: z.boolean(),
  sensitive: z.boolean(),
  storageScope: z.optional(z.enum(['account', 'local'])),
  targetKinds: z.optional(z.array(SettingsDeclarationTargetKindV1Schema)),
  targetRequired: z.optional(z.boolean()),
  allowedValues: z.optional(z.array(SettingsDeclarationScalarChoiceV1Schema)),
  operation: z.optional(z.strictObject({ actionId: z.literal('settings.invoke'), requiresHumanInteraction: z.boolean(), requiresApproval: z.optional(z.boolean()) })),
  unavailableReason: z.optional(z.enum(['not_bound', 'sensitive', 'read_only', 'unsupported_host', 'feature_disabled'])),
}));
const ValueResultSchema = lazyZodSchema(() => z.strictObject({ anchor: AnchorSchema, value: SettingsDeclarationValueV1Schema }));
const UnsetResultSchema = lazyZodSchema(() => z.strictObject({ anchor: AnchorSchema, unset: z.literal(true) }));
const SettingsVersionSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.int()));
export const SettingRawValueV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ unset: z.literal(true) }),
  z.strictObject({ value: SettingsDeclarationValueV1Schema }),
]));
/** Expected raw values for a bound-key reset; no historical mutation receipt is required. */
export const SettingsDeclarationResetExpectedV1Schema = lazyZodSchema(() => z.union([
  SettingRawValueV1Schema,
  z.strictObject({ changes: z.array(z.strictObject({ key: SettingKeySchema, applied: SettingRawValueV1Schema }))
    .check(z.minLength(1), z.refine(changes => new Set(changes.map(change => change.key)).size === changes.length)) }),
]));
export type SettingsDeclarationResetExpectedV1 = z.infer<typeof SettingsDeclarationResetExpectedV1Schema>;
const ReversalBasis = {
  scope: z.strictObject({ serverId: OperationIdSchema, accountId: OperationIdSchema }),
  beforeVersion: SettingsVersionSchema,
  appliedVersion: SettingsVersionSchema,
};
const SingleKeyReversal = { before: SettingRawValueV1Schema, applied: SettingRawValueV1Schema };
const MultiKeyReversal = { changes: z.array(z.strictObject({ key: SettingKeySchema, ...SingleKeyReversal }))
  .check(z.minLength(1), z.refine(changes => new Set(changes.map(change => change.key)).size === changes.length)) };
/** One-key receipts retain their existing shape; compound mutations name every affected raw key. */
export const SettingsDeclarationCapturedMutationV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ beforeVersion: SettingsVersionSchema, ...SingleKeyReversal }),
  z.strictObject({ beforeVersion: SettingsVersionSchema, ...MultiKeyReversal }),
]));
const consecutiveVersions = (value: { beforeVersion: number; appliedVersion: number }) => value.appliedVersion === value.beforeVersion + 1;
/** Versions describe the captured transition; restore CAS compares the affected current values. */
export const SettingsDeclarationMutationReversalV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...ReversalBasis, ...SingleKeyReversal }).check(z.refine(consecutiveVersions)),
  z.strictObject({ ...ReversalBasis, ...MultiKeyReversal }).check(z.refine(consecutiveVersions)),
]));
export type SettingsDeclarationMutationReversalV1 = z.infer<typeof SettingsDeclarationMutationReversalV1Schema>;
const SettingReversalInputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('capture') }),
  z.strictObject({ kind: z.literal('restore'), ...ReversalBasis, ...SingleKeyReversal }).check(z.refine(consecutiveVersions)),
  z.strictObject({ kind: z.literal('restore'), ...ReversalBasis, ...MultiKeyReversal }).check(z.refine(consecutiveVersions)),
]));

export const SettingsDeclarationActionInputSchemasV1 = {
  'settings.list': z.strictObject({ pageId: z.optional(z.string().check(z.trim(), z.minLength(1))) }),
  'settings.get': z.strictObject({ anchor: AnchorSchema, key: z.optional(SettingKeySchema), target: z.optional(SettingsDeclarationTargetV1Schema), includeVersion: z.optional(z.literal(true)) }),
  'settings.set': z.strictObject({ anchor: AnchorSchema, key: z.optional(SettingKeySchema), value: SettingsDeclarationValueV1Schema, target: z.optional(SettingsDeclarationTargetV1Schema),
    expectedSettingsVersion: z.optional(SettingsVersionSchema), reversal: z.optional(SettingReversalInputSchema) }),
  'settings.reset': z.strictObject({ anchor: AnchorSchema, key: z.optional(SettingKeySchema), target: z.optional(SettingsDeclarationTargetV1Schema),
    expected: z.optional(SettingsDeclarationResetExpectedV1Schema) }),
  'settings.invoke': z.strictObject({ anchor: AnchorSchema, input: z.optional(SettingsDeclarationOperationInputV1Schema), target: z.optional(SettingsDeclarationTargetV1Schema) }),
} as const;
export const SettingsDeclarationActionOutputSchemasV1 = {
  'settings.list': z.strictObject({ items: z.array(SettingsDeclarationDescriptorV1Schema) }),
  'settings.get': z.union([lazyZodSchema(() => z.extend(ValueResultSchema, { settingsVersion: z.optional(SettingsVersionSchema) })),
    lazyZodSchema(() => z.extend(UnsetResultSchema, { settingsVersion: z.optional(SettingsVersionSchema) }))]),
  'settings.set': z.union([
    lazyZodSchema(() => z.extend(ValueResultSchema, { settingsVersion: z.optional(SettingsVersionSchema),
      reversal: z.optional(SettingsDeclarationMutationReversalV1Schema), reversalUnavailableReason: z.optional(z.literal('no_change')) })),
    lazyZodSchema(() => z.extend(UnsetResultSchema, { settingsVersion: z.optional(SettingsVersionSchema),
      reversal: z.optional(SettingsDeclarationMutationReversalV1Schema), reversalUnavailableReason: z.optional(z.literal('no_change')) })),
  ]),
  'settings.reset': z.union([ValueResultSchema, UnsetResultSchema]),
  'settings.invoke': z.strictObject({
    anchor: AnchorSchema,
    status: z.enum(['completed', 'cancelled', 'unavailable', 'interaction_opened']),
    reason: z.optional(z.string().check(z.minLength(1))),
    value: z.optional(StrictJsonValueSchema),
  }),
} as const;
export type SettingsDeclarationDescriptorV1 = z.infer<typeof SettingsDeclarationDescriptorV1Schema>;
