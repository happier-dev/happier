import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ManagedResourceDependencyV1Schema, ManagedResourceDispositionV1Schema } from '../../machines/managed/managedDependencyV1.js';

import { AccountSettingsStoredContentEnvelopeSchema } from './accountSettingsStoredContentEnvelope.js';
import { SavedSecretCatalogResultV1Schema } from './savedSecretCatalogV1.js';
import { SavedSecretResourceStoredContentV1Schema } from './savedSecretResourceContentSchemaV1.js';
import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { ProfileRecordIdV1Schema, ProfileReferenceGuardRevisionV1Schema, ProfileRowMutationV1Schema, ProfileRowRevisionV1Schema } from '../../profiles/profileRecordSchemaV1.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactActionsV1.js';

import { SHARED_SAVED_SECRET_ACTION_IDS_V1, type SharedSavedSecretActionIdV1 } from './savedSecretResourceActionIdsV1.js';
export { SHARED_SAVED_SECRET_ACTION_IDS_V1, type SharedSavedSecretActionIdV1 } from './savedSecretResourceActionIdsV1.js';
export const SharedSavedSecretActionIdV1Schema = lazyZodSchema(() => z.enum(SHARED_SAVED_SECRET_ACTION_IDS_V1));

const ResourceIdSchema = lazyZodSchema(() => z.string().min(1).max(128));
const GrantIdSchema = lazyZodSchema(() => z.string().min(1));

/** Complete opened Profile inventory; the guard covers concurrent new identities. */
export const SavedSecretReferenceCensusV1Schema = lazyZodSchema(() => z.object({
  accountMode: z.enum(['plain', 'e2ee']),
  /** The incumbent control CAS also fences source-sensitive promotion. */
  profileTransferRevision: ProfileReferenceGuardRevisionV1Schema.optional(),
  profiles: z.object({
    referenceGuardRevision: ProfileReferenceGuardRevisionV1Schema,
    rows: z.array(z.object({ id: ProfileRecordIdV1Schema, revision: ProfileRowRevisionV1Schema }).strict()),
  }).strict(),
  /** Only explicitly reached definitions, never the automatic shared catalog. */
  artifacts: z.array(ArtifactRevisionV1Schema.extend({ artifactId: z.string().min(1) }).strict()).optional(),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.profiles.rows.forEach((row, index) => {
    if (ids.has(row.id)) context.addIssue({ code: 'custom', path: ['profiles', 'rows', index, 'id'], message: 'Duplicate Profile census identity' });
    ids.add(row.id);
  });
  const artifactIds = new Set<string>();
  value.artifacts?.forEach((artifact, index) => {
    if (artifactIds.has(artifact.artifactId)) context.addIssue({ code: 'custom', path: ['artifacts', index, 'artifactId'], message: 'Duplicate reached Artifact census identity' });
    artifactIds.add(artifact.artifactId);
  });
}));
export type SavedSecretReferenceCensusV1 = z.infer<typeof SavedSecretReferenceCensusV1Schema>;

export const SavedSecretResourceRecipientEnvelopeInputV1Schema = lazyZodSchema(() => z.object({
  recipientAccountId: z.string().min(1),
  encryptedDataKey: z.string().refine(
    (value) => readCanonicalPaddedBase64DecodedLength(value) === ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
    'Expected one canonical encrypted data-key envelope',
  ),
  recipientContentPublicKeyFingerprint: z.string().min(1),
}).strict());

export const SharedSavedSecretListInputV1Schema = lazyZodSchema(() => z.object({}).strict());
export const SharedSavedSecretListOutputV1Schema = lazyZodSchema(() => z.object({
  resources: z.array(SavedSecretCatalogResultV1Schema),
}).strict());

export const SharedSavedSecretCreateInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: ResourceIdSchema,
  displayName: z.string().min(1).max(100),
  kind: z.enum(['apiKey', 'token', 'password', 'other']),
  encryptionMode: z.enum(['plain', 'e2ee']),
  storedContent: SavedSecretResourceStoredContentV1Schema,
  accountGrants: z.array(GrantIdSchema).optional(),
  teamGrants: z.array(GrantIdSchema).optional(),
  groupGrants: z.array(GrantIdSchema).optional(),
  keyEnvelopes: z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema).optional(),
}).strict());

export type SharedSavedSecretCreateInputV1 = z.infer<typeof SharedSavedSecretCreateInputV1Schema>;

export const SharedSavedSecretPromoteInputV1Schema = lazyZodSchema(() => SharedSavedSecretCreateInputV1Schema.extend({
  expectedSettingsVersion: z.number().int().nonnegative(),
  nextSettings: AccountSettingsStoredContentEnvelopeSchema.nullable(),
  referenceCensus: SavedSecretReferenceCensusV1Schema,
  profileMutations: z.array(ProfileRowMutationV1Schema).default([]),
}).strict());

export const SharedSavedSecretGrantsSetInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: ResourceIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  accountGrants: z.array(GrantIdSchema),
  teamGrants: z.array(GrantIdSchema),
  groupGrants: z.array(GrantIdSchema),
  /** Complete current E2EE recipient envelopes for the replacement audience. */
  keyEnvelopes: z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema).optional(),
}).strict());

/** Internal owner repair after an audience/key change; this is not an Action. */
export const SavedSecretResourceEnvelopeRepairInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: ResourceIdSchema,
  expectedRevision: z.number().int().positive(),
  keyEnvelopes: z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema).min(1),
}).strict());

export const SharedSavedSecretUpdateInputV1Schema = lazyZodSchema(() => z.object({
  resourceId: ResourceIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  displayName: z.string().min(1).max(100),
  kind: z.enum(['apiKey', 'token', 'password', 'other']),
  storedContent: SavedSecretResourceStoredContentV1Schema,
  /**
   * Explicit owner mode conversion (plan 10.08 §10.5/§11.0). Absent keeps the
   * resource's current mode, so rename and value rotation are unchanged; the
   * submitted `storedContent` must always match the resulting mode.
   */
  toMode: z.enum(['plain', 'e2ee']).optional(),
  /** Owner and current-recipient envelopes for a Plain to E2EE conversion. */
  keyEnvelopes: z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema).optional(),
}).strict());

export const SharedSavedSecretDeleteInputV1Schema = lazyZodSchema(() => z.object({
  // Deletion is also the recovery path for retained corrupt rows, whose opaque
  // database identity must not be reinterpreted as a canonical resource id.
  resourceId: z.string(),
  expectedRevision: z.number().int(),
  expectedSettingsVersion: z.number().int().nonnegative(),
  referenceCensus: SavedSecretReferenceCensusV1Schema,
  managedResourceDispositions: z.array(ManagedResourceDispositionV1Schema).optional(),
}).strict());

export const SharedSavedSecretMutationOutputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
}).strict());
export const SavedSecretResourceEnvelopeRepairOutputV1Schema = SharedSavedSecretMutationOutputV1Schema;
export const SharedSavedSecretPromoteOutputV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  settingsVersion: z.number().int().nonnegative(),
}).strict());
export const SharedSavedSecretDeleteOutputV1Schema = lazyZodSchema(() => z.object({ resourceId: z.string() }).strict());

export const SavedSecretResourceActionErrorV1Schema = lazyZodSchema(() => z.union([z.object({
  error: z.enum([
    'invalid_resource', 'resource_not_found', 'forbidden', 'resource_changed',
    'recipient_changed', 'recipient_key_unavailable', 'invalid_cursor',
    'recipient_mode_unsupported', 'settings_conflict', 'settings_invalid', 'internal',
    'references_conflict', 'references_invalid', 'resource_in_use',
  ]),
}).strict(), z.object({
  error: z.literal('managed_resources_review_required'),
  resources: z.array(ManagedResourceDependencyV1Schema),
}).strict()]));

export const SHARED_SAVED_SECRET_ACTION_PATHS_V1 = {
  'secrets.shared.list': '/v1/account/saved-secrets/resources',
  'secrets.shared.create': '/v1/account/saved-secrets/resources',
  'secrets.shared.promote': '/v1/account/saved-secrets/resources/promote',
  'secrets.shared.grants.set': '/v1/account/saved-secrets/resources/grants',
  'secrets.shared.update': '/v1/account/saved-secrets/resources/update',
  'secrets.shared.delete': '/v1/account/saved-secrets/resources/delete',
} as const satisfies Readonly<Record<SharedSavedSecretActionIdV1, string>>;

export const SHARED_SAVED_SECRET_ACTION_METHODS_V1 = {
  'secrets.shared.list': 'GET',
  'secrets.shared.create': 'POST',
  'secrets.shared.promote': 'POST',
  'secrets.shared.grants.set': 'POST',
  'secrets.shared.update': 'POST',
  'secrets.shared.delete': 'POST',
} as const satisfies Readonly<Record<SharedSavedSecretActionIdV1, 'GET' | 'POST'>>;

export const SHARED_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1 = {
  'secrets.shared.list': SharedSavedSecretListInputV1Schema,
  'secrets.shared.create': SharedSavedSecretCreateInputV1Schema,
  'secrets.shared.promote': SharedSavedSecretPromoteInputV1Schema,
  'secrets.shared.grants.set': SharedSavedSecretGrantsSetInputV1Schema,
  'secrets.shared.update': SharedSavedSecretUpdateInputV1Schema,
  'secrets.shared.delete': SharedSavedSecretDeleteInputV1Schema,
} as const satisfies Readonly<Record<SharedSavedSecretActionIdV1, z.ZodTypeAny>>;

export const SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 = {
  'secrets.shared.list': SharedSavedSecretListOutputV1Schema,
  'secrets.shared.create': SharedSavedSecretMutationOutputV1Schema,
  'secrets.shared.promote': SharedSavedSecretPromoteOutputV1Schema,
  'secrets.shared.grants.set': SharedSavedSecretMutationOutputV1Schema,
  'secrets.shared.update': SharedSavedSecretMutationOutputV1Schema,
  'secrets.shared.delete': SharedSavedSecretDeleteOutputV1Schema,
} as const satisfies Readonly<Record<SharedSavedSecretActionIdV1, z.ZodTypeAny>>;
