import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AIBackendProfileSchema } from './backendProfileSchema.js';
import { getBuiltInBackendProfile } from './builtInBackendProfiles.js';
import { isHistoricalBuiltInAiLaunchProfileIdV1 } from './historicalCompatibilityV1.js';
import { LaunchProfileV2Schema, StoredLaunchProfileV2Schema } from './v2/schema.js';
import { ProfileRecordIdV1Schema } from './v2/profileId.js';
export { ProfileRecordIdV1Schema } from './v2/profileId.js';
import { PromptStackEntryV1Schema } from '../prompts/library/promptStacksV1.js';
import { AccountSettingsStoredContentEnvelopeSchema } from '../account/settings/accountSettingsStoredContentEnvelope.js';
import { listSavedSecretReferenceCarrierPathsV1, parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { EnvVarRequirementSchema } from './environmentVariables.js';
import { isCanonicalProviderSavedSecretIdV1 } from '../providers/settings/v1.js';
import { ProfileTransferContentV1Schema, ProfileTransferRowReadResponseV1Schema } from './profileTransferSchemaV1.js';
import { isAccountScopedBlobCiphertextForKind } from '../crypto/accountScopedCipherEnvelope.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactActionsV1.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { readLaunchProfileArtifactV1 } from '../launchProfiles/launchProfileArtifactV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

function isCanonicalProfileSavedSecretReference(value: string): boolean {
  if (!isCanonicalProviderSavedSecretIdV1(value)) return false;
  try { parseSavedSecretRefV1(value); return true; } catch { return false; }
}

const ProfileSavedSecretReferenceV1Schema = lazyZodSchema(() => z.string()
  .refine(isCanonicalProfileSavedSecretReference, 'Saved-secret reference must be canonical'));
export const ProfileSecretBindingsV1Schema = lazyZodSchema(() => z.record(EnvVarRequirementSchema.shape.name,
  ProfileSavedSecretReferenceV1Schema));
export const ProfileSecretBindingOverridesV1Schema = lazyZodSchema(() => z.record(EnvVarRequirementSchema.shape.name,
  ProfileSavedSecretReferenceV1Schema.nullable()));

/** Missing slots inherit shared defaults; explicit none suppresses only that private slot. */
export function resolveEffectiveProfileSecretBindingsV1(defaultBindings: Readonly<Record<string, string>>,
  privateOverrides: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> {
  const bindings = { ...defaultBindings };
  for (const [name, reference] of Object.entries(privateOverrides)) {
    if (reference === null) delete bindings[name];
    else bindings[name] = reference;
  }
  return bindings;
}

export const ProfileRecordV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), id: ProfileRecordIdV1Schema,
  definition: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inline'), profile: StoredLaunchProfileV2Schema }).strict(),
    z.object({ kind: z.literal('artifact'), artifactId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('legacy'), profile: AIBackendProfileSchema.strict() }).strict(),
  ]),
  enabled: z.boolean(), promptStack: z.array(PromptStackEntryV1Schema),
  secretBindings: ProfileSecretBindingOverridesV1Schema,
}).strict().superRefine((record, context) => {
  if (record.definition.kind !== 'artifact' && record.definition.profile.id !== record.id) {
    context.addIssue({ code: 'custom', path: ['definition', 'profile', 'id'], message: 'Profile definition must match its record identity' });
  }
}));
export type ProfileRecordV1 = z.infer<typeof ProfileRecordV1Schema>;
export const StoredProfileRecordV1Schema = createStoredReadSchema(ProfileRecordV1Schema);

/** Code-owned current presets admit only private attachments, never a changed definition. */
export function hasChangedCurrentBuiltinProfileDefinitionV1(record: ProfileRecordV1): boolean {
  const preset = getBuiltInBackendProfile(record.id);
  return preset?.id === record.id && (record.definition.kind !== 'legacy'
    || JSON.stringify(record.definition.profile) !== JSON.stringify(AIBackendProfileSchema.parse(preset)));
}

/** A retained readonly blueprint remains its captured definition while private attachments may change. */
export function hasChangedReadonlyProfileDefinitionV1(previous: ProfileRecordV1, next: ProfileRecordV1,
  artifact?: ArtifactSharingResourceV1): boolean {
  if (previous.definition.kind !== 'legacy' || previous.definition.profile.isBuiltIn !== true) return false;
  if (next.definition.kind === 'artifact' && next.id === previous.id && artifact?.artifactId === next.definition.artifactId) {
    const opened = readLaunchProfileArtifactV1(artifact);
    if (opened?.profile.id === previous.id && Object.keys(opened.secretBindings).length === 0
      && sameStrictJsonValue(previous.definition.profile, opened.profile)) return false;
  }
  return JSON.stringify(previous.definition) !== JSON.stringify(next.definition);
}

/** Account-private transport, with no Resource key or grant semantics. */
export const ProfileRecordContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: ProfileRecordV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1) }).strict(),
]));
export type ProfileRecordContentV1 = z.infer<typeof ProfileRecordContentV1Schema>;
export const StoredProfileRecordContentV1Schema = createStoredReadSchema(ProfileRecordContentV1Schema);

export function hasUnrepresentedProfileSavedSecretReferencesV1(raw: unknown, projected: unknown): boolean {
  const admitted = new Set(listSavedSecretReferenceCarrierPathsV1(projected));
  return listSavedSecretReferenceCarrierPathsV1(raw).some(path => !admitted.has(path));
}

/** Legacy bodies have no version marker; never reinterpret a future version after projection drops it. */
export function hasUnsupportedLegacyProfileDefinitionVersionV1(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || !('definition' in raw)) return false;
  const definition = raw.definition;
  if (definition === null || typeof definition !== 'object' || !('kind' in definition)
    || definition.kind !== 'legacy' || !('profile' in definition)) return false;
  const profile = definition.profile;
  return profile !== null && typeof profile === 'object' && Object.hasOwn(profile, 'v');
}

/** Additive fields remain readable unless they hide reference carriers outside the admitted census. */
export function parseStoredProfileRecordContentV1(value: unknown): ProfileRecordContentV1 | null {
  const parsed = StoredProfileRecordContentV1Schema.safeParse(value);
  if (!parsed.success || hasUnrepresentedProfileSavedSecretReferencesV1(value, parsed.data)) return null;
  if (parsed.data.t === 'plain' && value !== null && typeof value === 'object' && 'v' in value
    && hasUnsupportedLegacyProfileDefinitionVersionV1(value.v)) return null;
  return parsed.data;
}

export const PROFILE_RECORD_ACCOUNT_SCOPED_BLOB_KIND_V1 = 'account_profile_record' as const;

export function assertProfileRecordContentForModeV1(content: ProfileRecordContentV1, mode: 'plain' | 'e2ee'): void {
  if ((mode === 'plain' && content.t !== 'plain') || (mode === 'e2ee' && (
    content.t !== 'encrypted' || !isAccountScopedBlobCiphertextForKind({ kind: PROFILE_RECORD_ACCOUNT_SCOPED_BLOB_KIND_V1, ciphertext: content.c })
  ))) throw new Error('account-mode-mismatch');
}

export const PROFILE_ROWS_ROUTE_V1 = '/v1/account/entity-rows/profiles' as const;
export const PROFILE_RECORDS_ROUTE_V1 = `${PROFILE_ROWS_ROUTE_V1}/records` as const;
export const PROFILE_RECORD_READ_ROUTE_V1 = `${PROFILE_RECORDS_ROUTE_V1}/read` as const;
export const PROFILE_REFERENCE_GUARD_ROUTE_V1 = `${PROFILE_ROWS_ROUTE_V1}/reference-guard` as const;
export const PROFILE_ACCOUNT_KV_PREFIX = '@happier/account/profiles/v1/' as const;
export const PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY = '@happier/account/profile-reference-guard/v1' as const;
export const PROFILE_TRANSFER_ACCOUNT_KV_KEY = '@happier/account/profile-transfer/v1' as const;
export function buildProfilePhysicalKey(profileId: string): string {
  return `${PROFILE_ACCOUNT_KV_PREFIX}${encodeURIComponent(ProfileRecordIdV1Schema.parse(profileId))}`;
}
export function parseProfilePhysicalKey(key: string): string | null {
  if (!key.startsWith(PROFILE_ACCOUNT_KV_PREFIX)) return null;
  try {
    const parsed = ProfileRecordIdV1Schema.safeParse(decodeURIComponent(key.slice(PROFILE_ACCOUNT_KV_PREFIX.length)));
    return parsed.success && buildProfilePhysicalKey(parsed.data) === key ? parsed.data : null;
  } catch { return null; }
}
/** Content-free Account change identity for this catalog and its two domain controls. */
export function isProfileCatalogAccountChangeEntityIdV1(entityId: string): boolean {
  return entityId === PROFILE_REFERENCE_GUARD_ACCOUNT_KV_KEY || entityId === PROFILE_TRANSFER_ACCOUNT_KV_KEY
    || parseProfilePhysicalKey(entityId) !== null;
}
export const ProfileRowRevisionV1Schema = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const ProfileRowOperationV1Schema = lazyZodSchema(() => z.enum(['create', 'attach-builtin', 'update', 'remove', 'import']));
type ProfileRowOperationV1 = z.infer<typeof ProfileRowOperationV1Schema>;

function validateProfileRecordMutationV1(input: Readonly<{ id: string; operation: ProfileRowOperationV1; record?: ProfileRecordV1 }>,
  context: z.RefinementCtx, recordPath: readonly (string | number)[],
): void {
  if (input.operation === 'create') {
    if (isHistoricalBuiltInAiLaunchProfileIdV1(input.id)) {
      context.addIssue({ code: 'custom', path: ['id'], message: 'Builtin identities are reserved for preset private attachments' });
    }
    if (input.record?.definition.kind === 'legacy') {
      context.addIssue({ code: 'custom', path: [...recordPath], message: 'Historical profiles are import-only' });
    } else if (input.record?.definition.kind === 'inline') {
      const authored = LaunchProfileV2Schema.safeParse(input.record.definition.profile);
      if (!authored.success) {
        for (const issue of authored.error.issues) context.addIssue({ ...issue,
          path: [...recordPath, 'definition', 'profile', ...issue.path] });
      } else if (authored.data.id !== input.id) {
        context.addIssue({ code: 'custom', path: [...recordPath, 'definition', 'profile', 'id'],
          message: 'New Profile authoring must match its exact record identity' });
      }
    }
  }
  if (input.operation === 'attach-builtin') {
    const preset = getBuiltInBackendProfile(input.id);
    if (!preset || preset.id !== input.id) {
      context.addIssue({ code: 'custom', path: ['id'], message: 'Builtin attachment requires an actual readonly preset' });
    } else if (input.record && hasChangedCurrentBuiltinProfileDefinitionV1(input.record)) {
      context.addIssue({ code: 'custom', path: [...recordPath], message: 'Builtin attachment cannot change the readonly definition' });
    }
  }
}

const ProfileRecordForMutationV1Schema = lazyZodSchema(() => z.object({
  operation: ProfileRowOperationV1Schema.exclude(['remove']), record: ProfileRecordV1Schema,
}).strict().superRefine((value, context) => validateProfileRecordMutationV1({
  id: value.record.id, operation: value.operation, record: value.record,
}, context, ['record'])));

/** Admit opened semantic writes before sealing in the actual Account mode. Imports and reseals retain inherited bytes. */
export function parseProfileRecordForMutationV1(input: Readonly<{
  operation: Exclude<ProfileRowOperationV1, 'remove'>; record: ProfileRecordV1;
}>): ProfileRecordV1 {
  const value = ProfileRecordForMutationV1Schema.parse(input);
  if (value.operation !== 'create' || value.record.definition.kind !== 'inline') return value.record;
  return { ...value.record, definition: { kind: 'inline', profile: LaunchProfileV2Schema.parse(value.record.definition.profile) } };
}

export const ProfileReferenceGuardRevisionV1Schema = lazyZodSchema(() => z.union([ProfileRowRevisionV1Schema, z.literal('absent')]));
export const ProfileRowV1Schema = lazyZodSchema(() => z.object({
  id: ProfileRecordIdV1Schema, revision: ProfileRowRevisionV1Schema,
  content: ProfileRecordContentV1Schema.nullable(),
}).strict());
export type ProfileRowV1 = z.infer<typeof ProfileRowV1Schema>;
export const ProfileRowReadRequestV1Schema = lazyZodSchema(() => z.object({ id: ProfileRecordIdV1Schema }).strict());
export type ProfileRowReadRequestV1 = z.infer<typeof ProfileRowReadRequestV1Schema>;
export const ProfileRowStorageFailureV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content', 'invalid-reference']),
  reason: z.string().optional(),
}).strict());
export const ProfileRowReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('present'), revision: ProfileRowRevisionV1Schema, content: ProfileRecordContentV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
  z.object({ status: z.literal('deleted'), revision: ProfileRowRevisionV1Schema }).strict(),
  ProfileRowStorageFailureV1Schema,
]));
export const ProfileRowsListResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({
    status: z.literal('listed'), rows: z.array(ProfileRowV1Schema), nextCursor: z.string().min(1).nullable(),
    complete: z.boolean(), referenceGuardRevision: ProfileReferenceGuardRevisionV1Schema,
    transferControl: ProfileTransferRowReadResponseV1Schema,
    diagnostics: z.array(z.object({ id: ProfileRecordIdV1Schema, revision: ProfileRowRevisionV1Schema,
      reason: z.literal('invalid-stored-content') }).strict()),
  }).strict(),
  ProfileRowStorageFailureV1Schema,
]));
export type ProfileRowsListResponseV1 = z.infer<typeof ProfileRowsListResponseV1Schema>;
export const ProfileRowMutationV1Schema = lazyZodSchema(() => z.object({
  id: ProfileRecordIdV1Schema, operation: ProfileRowOperationV1Schema,
  expectedRevision: ProfileReferenceGuardRevisionV1Schema,
  content: ProfileRecordContentV1Schema.nullable(),
  referencedSavedSecretIds: z.array(ProfileSavedSecretReferenceV1Schema).default([]),
  savedSecretRevisions: z.array(z.object({ resourceId: z.string().min(1), expectedRevision: ProfileRowRevisionV1Schema }).strict()).optional(),
  /** Explicit null proves that the opened opaque row selects no Artifact. */
  artifactRevision: ArtifactRevisionV1Schema.extend({ artifactId: z.string().min(1) }).strict().nullable().optional(),
  settingsCleanup: z.object({
    expectedSettingsVersion: ProfileRowRevisionV1Schema,
    nextSettings: AccountSettingsStoredContentEnvelopeSchema.nullable(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.artifactRevision !== undefined) {
    if (value.operation === 'remove') {
      context.addIssue({ code: 'custom', path: ['artifactRevision'], message: 'Removal selects no Artifact' });
    } else if (value.content?.t === 'plain') {
      const definition = value.content.v.definition;
      if (definition.kind === 'artifact' ? value.artifactRevision?.artifactId !== definition.artifactId : value.artifactRevision !== null) {
        context.addIssue({ code: 'custom', path: ['artifactRevision'], message: 'Artifact capture must match the selected definition' });
      }
    }
  }
  if (value.settingsCleanup !== undefined && value.operation !== 'remove' && value.operation !== 'attach-builtin') {
    context.addIssue({ code: 'custom', path: ['settingsCleanup'], message: 'Preference cleanup belongs only to Profile removal or first builtin attachment' });
  }
  if (value.operation === 'remove' ? value.content !== null : value.content === null) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'Only removal writes a tombstone' });
  }
  if ((value.operation === 'create' || value.operation === 'attach-builtin') && value.expectedRevision !== 'absent') {
    context.addIssue({ code: 'custom', path: ['expectedRevision'], message: 'Creation requires expected absence' });
  }
  if (value.content?.t === 'plain' && value.content.v.id !== value.id) {
    context.addIssue({ code: 'custom', path: ['content', 'v', 'id'], message: 'Profile payload must match addressed identity' });
  }
  validateProfileRecordMutationV1({ id: value.id, operation: value.operation,
    ...(value.content?.t === 'plain' ? { record: value.content.v } : {}) }, context, ['content', 'v']);
}).transform(value => value.content?.t === 'plain' && value.operation !== 'remove'
  ? { ...value, content: { t: 'plain' as const, v: parseProfileRecordForMutationV1({ operation: value.operation, record: value.content.v }) } }
  : value));
export type ProfileRowMutationV1 = z.infer<typeof ProfileRowMutationV1Schema>;
export const ProfileRowMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), revision: ProfileRowRevisionV1Schema,
    cursor: ProfileRowRevisionV1Schema, referenceGuardRevision: ProfileRowRevisionV1Schema }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('settings-conflict'), revision: ProfileRowRevisionV1Schema }).strict(),
  ProfileRowStorageFailureV1Schema,
]));
export type ProfileRowMutationResponseV1 = z.infer<typeof ProfileRowMutationResponseV1Schema>;
export const PROFILE_PROVIDER_CONVERSION_ROUTE_V1 = `${PROFILE_ROWS_ROUTE_V1}/provider-conversion` as const;
export const ProfileProviderConversionMutationV1Schema = lazyZodSchema(() => z.object({
  operation: z.literal('provider-conversion'), expectedAccountMode: z.enum(['plain', 'e2ee']),
  expectedSettingsVersion: ProfileRowRevisionV1Schema, expectedProfileTransferRevision: ProfileReferenceGuardRevisionV1Schema,
  expectedReferenceGuardRevision: ProfileReferenceGuardRevisionV1Schema,
  profileCensus: z.array(z.object({ id: ProfileRecordIdV1Schema, revision: ProfileRowRevisionV1Schema }).strict()),
  mutations: z.array(ProfileRowMutationV1Schema), nextSettings: AccountSettingsStoredContentEnvelopeSchema.nullable(),
}).strict().superRefine((value, context) => {
  const captured = new Map(value.profileCensus.map(row => [row.id, row.revision]));
  if (captured.size !== value.profileCensus.length) context.addIssue({ code: 'custom', path: ['profileCensus'], message: 'Duplicate captured Profile identity' });
  const mutations = new Set<string>();
  value.mutations.forEach((mutation, index) => {
    if (mutation.operation !== 'update' || mutation.settingsCleanup !== undefined || captured.get(mutation.id) !== mutation.expectedRevision || mutations.has(mutation.id)) {
      context.addIssue({ code: 'custom', path: ['mutations', index], message: 'Provider conversion updates each captured existing Profile at most once' });
    }
    mutations.add(mutation.id);
  });
  if (value.nextSettings !== null && value.nextSettings.t !== (value.expectedAccountMode === 'plain' ? 'plain' : 'encrypted')) {
    context.addIssue({ code: 'custom', path: ['nextSettings'], message: 'Provider Settings must match the captured Account mode' });
  }
}));
export type ProfileProviderConversionMutationV1 = z.infer<typeof ProfileProviderConversionMutationV1Schema>;
export const ProfileProviderConversionResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('updated'), settingsVersion: ProfileRowRevisionV1Schema,
    rows: z.array(ProfileRowV1Schema), referenceGuardRevision: ProfileReferenceGuardRevisionV1Schema }).strict(),
  z.object({ status: z.literal('reference-conflict') }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int().min(-1) }).strict(),
  z.object({ status: z.literal('settings-conflict'), revision: ProfileRowRevisionV1Schema }).strict(),
  ProfileRowStorageFailureV1Schema,
]));
export type ProfileProviderConversionResponseV1 = z.infer<typeof ProfileProviderConversionResponseV1Schema>;
export const ProfileReferenceGuardReadResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('ready'), revision: ProfileReferenceGuardRevisionV1Schema }).strict(),
  ProfileRowStorageFailureV1Schema,
]));

/** All introduced Profile rows participate in the incumbent atomic Account conversion. */
export const AccountEncryptionMigrateProfileRowsDirectiveSchema = lazyZodSchema(() => z.object({
  items: z.array(z.object({ id: ProfileRecordIdV1Schema, expectedRevision: ProfileRowRevisionV1Schema,
    content: ProfileRecordContentV1Schema }).strict()),
  expectedReferenceGuardRevision: ProfileReferenceGuardRevisionV1Schema,
  transferControl: z.object({ expectedRevision: ProfileReferenceGuardRevisionV1Schema, content: ProfileTransferContentV1Schema.nullable() }).strict(),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.items.forEach((item, index) => {
    if (seen.has(item.id)) context.addIssue({ code: 'custom', path: ['items', index, 'id'], message: 'Duplicate Profile conversion identity' });
    if (item.content.t === 'plain' && item.id !== item.content.v.id) context.addIssue({ code: 'custom', path: ['items', index, 'content'], message: 'Profile payload identity mismatch' });
    seen.add(item.id);
  });
}));
export type AccountEncryptionMigrateProfileRowsDirective = z.infer<typeof AccountEncryptionMigrateProfileRowsDirectiveSchema>;
export const AccountEncryptionMigrateProfileRowsResultSchema = lazyZodSchema(() => z.object({
  rows: z.array(ProfileRowV1Schema), referenceGuardRevision: ProfileReferenceGuardRevisionV1Schema,
  transferControl: ProfileTransferRowReadResponseV1Schema,
}).strict());
