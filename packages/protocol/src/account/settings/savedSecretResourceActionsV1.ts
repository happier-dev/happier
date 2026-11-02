import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ManagedResourceDependencyV1Schema, ManagedResourceDispositionV1Schema } from '../../machines/managed/managedDependencyV1.js';

import { AccountSettingsStoredContentEnvelopeSchema } from './accountSettingsStoredContentEnvelope.js';
import { SavedSecretCatalogResultV1Schema } from './savedSecretCatalogV1.js';
import { SavedSecretResourceStoredContentV1Schema } from './savedSecretResourceContentSchemaV1.js';
import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { ProfileRecordIdV1Schema, ProfileReferenceGuardRevisionV1Schema, ProfileRowMutationV1Schema, ProfileRowRevisionV1Schema } from '../../profiles/profileRecordSchemaV1.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactActionsV1.js';
import { McpServerCatalogRowMutationV1Schema } from '../../mcp/servers/catalogSchemasV1.js';
import { AcpCatalogRowMutationV1Schema } from '../../acp/catalog/catalogSchemasV1.js';
import { ProviderConnectionsRowMutationV1Schema } from '../../providers/connections/catalogSchemasV1.js';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogKeyV1 } from '../../connect/connectedAccountCatalogSchemasV1.js';
import { parseSavedSecretRefV1 } from './savedSecretReferenceV1.js';
import { RemoteHostCatalogRowMutationV1Schema } from '../../remoteHosts/remoteHostSchemasV1.js';
import { NotificationChannelCatalogMutationV1Schema } from './notificationChannelSchemasV1.js';
import { PromptLibraryRowMutationV1Schema } from '../../prompts/library/promptLibrarySchemasV1.js';

import { SHARED_SAVED_SECRET_ACTION_IDS_V1, type SharedSavedSecretActionIdV1 } from './savedSecretResourceActionIdsV1.js';
export { SHARED_SAVED_SECRET_ACTION_IDS_V1, type SharedSavedSecretActionIdV1 } from './savedSecretResourceActionIdsV1.js';
export const SharedSavedSecretActionIdV1Schema = lazyZodSchema(() => z.enum(SHARED_SAVED_SECRET_ACTION_IDS_V1));

const ResourceIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(128)));
const GrantIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const SharedResourceReferenceSchema = lazyZodSchema(() => z.string().check(z.refine(value => {
  try { return parseSavedSecretRefV1(value).kind === 'shared_resource'; } catch { return false; }
}, 'Expected a shared Saved Secret resource reference')));

export const SavedSecretCatalogRevisionsV1Schema = lazyZodSchema(() => z.strictObject({
  mcp: ProfileReferenceGuardRevisionV1Schema,
  acp: ProfileReferenceGuardRevisionV1Schema,
  providerConnections: ProfileReferenceGuardRevisionV1Schema,
  connectedConfigurations: ProfileReferenceGuardRevisionV1Schema,
  connectedPurposes: ProfileReferenceGuardRevisionV1Schema,
  registrySources: z.optional(ProfileReferenceGuardRevisionV1Schema),
}));
export type SavedSecretCatalogRevisionsV1 = z.infer<typeof SavedSecretCatalogRevisionsV1Schema>;

const SavedSecretRemoteHostReferenceCensusV1Schema = lazyZodSchema(() => z.strictObject({
  revision: ProfileReferenceGuardRevisionV1Schema,
  resourceRefs: z.array(SharedResourceReferenceSchema),
}));
const SavedSecretNotificationChannelReferenceCensusV1Schema = lazyZodSchema(() => z.strictObject({
  revision: ProfileReferenceGuardRevisionV1Schema,
  resourceRefs: z.array(SharedResourceReferenceSchema),
}));

/** Complete opened Profile inventory; the guard covers concurrent new identities. */
export const SavedSecretReferenceCensusV1Schema = lazyZodSchema(() => z.strictObject({
  accountMode: z.enum(['plain', 'e2ee']),
  /** The incumbent control CAS also fences source-sensitive promotion. */
  profileTransferRevision: z.optional(ProfileReferenceGuardRevisionV1Schema),
  profiles: z.strictObject({
    referenceGuardRevision: ProfileReferenceGuardRevisionV1Schema,
    rows: z.array(z.strictObject({ id: ProfileRecordIdV1Schema, revision: ProfileRowRevisionV1Schema })),
  }),
  /** Only explicitly reached definitions, never the automatic shared catalog. */
  artifacts: z.optional(z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ArtifactRevisionV1Schema, { artifactId: z.string().check(z.minLength(1)) })))),
  /** When catalog references are reached, all active catalog authorities are captured. */
  catalogs: z.optional(SavedSecretCatalogRevisionsV1Schema),
  remoteHosts: z.optional(SavedSecretRemoteHostReferenceCensusV1Schema),
  notificationChannels: z.optional(SavedSecretNotificationChannelReferenceCensusV1Schema),
}).check(z.superRefine((value, context) => {
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
})));
export type SavedSecretReferenceCensusV1 = z.infer<typeof SavedSecretReferenceCensusV1Schema>;

/** Promotion of existing catalog references does not claim a Profile inventory. */
export const SavedSecretCatalogReferenceCensusV1Schema = lazyZodSchema(() => z.strictObject({
  scope: z.literal('catalogs'),
  accountMode: z.enum(['plain', 'e2ee']),
  catalogs: z.partial(SavedSecretCatalogRevisionsV1Schema),
  remoteHosts: z.optional(SavedSecretRemoteHostReferenceCensusV1Schema),
  notificationChannels: z.optional(SavedSecretNotificationChannelReferenceCensusV1Schema),
}));
export type SavedSecretCatalogReferenceCensusV1 = z.infer<typeof SavedSecretCatalogReferenceCensusV1Schema>;
export const SavedSecretPromoteReferenceCensusV1Schema = lazyZodSchema(() => z.union([
  SavedSecretReferenceCensusV1Schema, SavedSecretCatalogReferenceCensusV1Schema,
]));
export type SavedSecretPromoteReferenceCensusV1 = z.infer<typeof SavedSecretPromoteReferenceCensusV1Schema>;

function connectedCatalogSecretMutationSchema(key: ConnectedAccountCatalogKeyV1) {
  return lazyZodSchema(() => z.safeExtend(ConnectedAccountCatalogRowMutationV1Schema, {
    // The outer resource transaction is the sole paired Settings writer.
    settingsMutation: z.optional(z.never()),
  }).check(z.superRefine((mutation, context) => {
    if (mutation.content?.t === 'plain' && mutation.content.v.key !== key) {
      context.addIssue({ code: 'custom', path: ['content'], message: 'Catalog content must match its mutation arm' });
    }
  })));
}

export const SavedSecretCatalogMutationsV1Schema = lazyZodSchema(() => z.strictObject({
  mcp: z.optional(McpServerCatalogRowMutationV1Schema),
  acp: z.optional(AcpCatalogRowMutationV1Schema),
  providerConnections: z.optional(ProviderConnectionsRowMutationV1Schema),
  connectedConfigurations: z.optional(connectedCatalogSecretMutationSchema('configurations')),
  connectedPurposes: z.optional(connectedCatalogSecretMutationSchema('purposes')),
  registrySources: z.optional(PromptLibraryRowMutationV1Schema.check(z.superRefine((mutation, context) => {
    if (mutation.content?.t === 'plain' && mutation.content.v.key !== 'registry-sources') {
      context.addIssue({ code: 'custom', path: ['content'], message: 'Registry token mutation must address registry sources' });
    }
  }))),
}));
export type SavedSecretCatalogMutationsV1 = z.infer<typeof SavedSecretCatalogMutationsV1Schema>;

export const SavedSecretResourceRecipientEnvelopeInputV1Schema = lazyZodSchema(() => z.strictObject({
  recipientAccountId: z.string().check(z.minLength(1)),
  encryptedDataKey: z.string().check(z.refine((value) => readCanonicalPaddedBase64DecodedLength(value) === ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 'Expected one canonical encrypted data-key envelope')),
  recipientContentPublicKeyFingerprint: z.string().check(z.minLength(1)),
}));

export const SharedSavedSecretListInputV1Schema = lazyZodSchema(() => z.strictObject({}));
export const SharedSavedSecretListOutputV1Schema = lazyZodSchema(() => z.strictObject({
  resources: z.array(SavedSecretCatalogResultV1Schema),
}));

export const SharedSavedSecretCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: ResourceIdSchema,
  displayName: z.string().check(z.minLength(1), z.maxLength(100)),
  kind: z.enum(['apiKey', 'token', 'password', 'other']),
  encryptionMode: z.enum(['plain', 'e2ee']),
  storedContent: SavedSecretResourceStoredContentV1Schema,
  accountGrants: z.optional(z.array(GrantIdSchema)),
  teamGrants: z.optional(z.array(GrantIdSchema)),
  groupGrants: z.optional(z.array(GrantIdSchema)),
  keyEnvelopes: z.optional(z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema)),
}));

export type SharedSavedSecretCreateInputV1 = z.infer<typeof SharedSavedSecretCreateInputV1Schema>;

/** Source identities for equivalent reference rewrites owned by the promotion transaction. */
export const SavedSecretPersonalPromotionsV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  // Retained SavedSecret.id is opaque, including a same-spelling Resource ref.
  // The source owner proves provenance; the transaction validates source custody.
  personalSecretId: z.string().check(z.minLength(1)),
  resourceId: ResourceIdSchema,
})).check(z.superRefine((promotions, context) => {
  const sources = new Set<string>();
  const destinations = new Set<string>();
  promotions.forEach((promotion, index) => {
    if (sources.has(promotion.personalSecretId) || destinations.has(promotion.resourceId)) {
      context.addIssue({ code: 'custom', path: [index], message: 'Personal promotion source and destination identities must be unique' });
    }
    sources.add(promotion.personalSecretId);
    destinations.add(promotion.resourceId);
  });
})));
export type SavedSecretPersonalPromotionsV1 = z.infer<typeof SavedSecretPersonalPromotionsV1Schema>;

export const SharedSavedSecretPromoteInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SharedSavedSecretCreateInputV1Schema, {
  expectedSettingsVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
  nextSettings: z.nullable(AccountSettingsStoredContentEnvelopeSchema),
  referenceCensus: SavedSecretPromoteReferenceCensusV1Schema,
  profileMutations: z._default(z.array(ProfileRowMutationV1Schema), []),
  catalogMutations: z.optional(SavedSecretCatalogMutationsV1Schema),
  additionalSavedSecretResources: z.optional(z.array(SharedSavedSecretCreateInputV1Schema)),
  personalSecretPromotions: z.optional(SavedSecretPersonalPromotionsV1Schema),
  remoteHostMutation: z.optional(RemoteHostCatalogRowMutationV1Schema),
  notificationChannelMutation: z.optional(z.safeExtend(NotificationChannelCatalogMutationV1Schema, {
    // The outer resource transaction remains the sole paired Settings writer.
    settingsMutation: z.optional(z.never()),
  })),
})).check(z.superRefine((value, context) => {
  const catalogOnly = 'scope' in value.referenceCensus;
  if (catalogOnly) {
    if (value.nextSettings !== null) context.addIssue({ code: 'custom', path: ['nextSettings'], message: 'Catalog-only promotion cannot write Settings' });
    if (value.profileMutations.length !== 0) context.addIssue({ code: 'custom', path: ['profileMutations'], message: 'Catalog-only promotion cannot mutate Profiles' });
    if (value.personalSecretPromotions?.length) context.addIssue({ code: 'custom', path: ['personalSecretPromotions'], message: 'Catalog-only promotion cannot rewrite personal source references' });
  } else if (value.expectedSettingsVersion === undefined) {
    context.addIssue({ code: 'custom', path: ['expectedSettingsVersion'], message: 'Full reference census requires captured Settings currentness' });
  }
  let mutationCount = 0;
  for (const key of ['mcp', 'acp', 'providerConnections', 'connectedConfigurations', 'connectedPurposes', 'registrySources'] as const) {
    const mutation = value.catalogMutations?.[key];
    const captured = value.referenceCensus.catalogs?.[key];
    if (mutation) {
      mutationCount += 1;
      if (captured === undefined || captured !== mutation.expectedRevision) {
        context.addIssue({ code: 'custom', path: ['catalogMutations', key, 'expectedRevision'], message: 'Catalog mutation must match its captured revision' });
      }
      if (catalogOnly && (mutation.expectedRevision === 'absent' || mutation.sourceSettingsVersion !== undefined
        || 'source' in mutation && mutation.source !== undefined)) {
        context.addIssue({ code: 'custom', path: ['catalogMutations', key], message: 'Catalog-only promotion changes existing destination authority only' });
      }
    } else if (catalogOnly && captured !== undefined) {
      context.addIssue({ code: 'custom', path: ['referenceCensus', 'catalogs', key], message: 'Catalog-only census captures exactly the mutated catalogs' });
    }
  }
  if (value.remoteHostMutation) {
    mutationCount += 1;
    if (value.referenceCensus.remoteHosts?.revision !== value.remoteHostMutation.expectedRevision
      && !(value.referenceCensus.remoteHosts === undefined && !catalogOnly && value.remoteHostMutation.expectedRevision === 'absent')) {
      context.addIssue({ code: 'custom', path: ['remoteHostMutation', 'expectedRevision'], message: 'Remote Host mutation must match its captured revision' });
    }
  } else if (catalogOnly && value.referenceCensus.remoteHosts !== undefined) {
    context.addIssue({ code: 'custom', path: ['referenceCensus', 'remoteHosts'], message: 'Catalog-only census captures exactly the mutated catalogs' });
  }
  if (value.notificationChannelMutation) {
    mutationCount += 1;
    if (value.referenceCensus.notificationChannels?.revision !== value.notificationChannelMutation.expectedRevision) {
      context.addIssue({ code: 'custom', path: ['notificationChannelMutation', 'expectedRevision'], message: 'Notification channel mutation must match its captured revision' });
    }
    if (catalogOnly && (value.notificationChannelMutation.expectedRevision === 'absent'
      || value.notificationChannelMutation.sourceSettingsVersion !== undefined)) {
      context.addIssue({ code: 'custom', path: ['notificationChannelMutation'], message: 'Catalog-only promotion changes existing destination authority only' });
    }
  } else if (catalogOnly && value.referenceCensus.notificationChannels !== undefined) {
    context.addIssue({ code: 'custom', path: ['referenceCensus', 'notificationChannels'], message: 'Catalog-only census captures exactly the mutated catalogs' });
  }
  if (catalogOnly && mutationCount === 0) {
    context.addIssue({ code: 'custom', path: ['catalogMutations'], message: 'Catalog-only promotion requires a catalog mutation' });
  }
  const resourceIds = new Set([value.resourceId]);
  value.additionalSavedSecretResources?.forEach((resource, index) => {
    if (resourceIds.has(resource.resourceId)) {
      context.addIssue({ code: 'custom', path: ['additionalSavedSecretResources', index, 'resourceId'], message: 'SavedSecret batch identities must be unique' });
    }
    resourceIds.add(resource.resourceId);
  });
  value.personalSecretPromotions?.forEach((promotion, index) => {
    if (!resourceIds.has(promotion.resourceId)) {
      context.addIssue({ code: 'custom', path: ['personalSecretPromotions', index, 'resourceId'], message: 'Personal promotion destination must be a resource in this request' });
    }
  });
})));
export type SharedSavedSecretPromoteInputV1 = z.infer<typeof SharedSavedSecretPromoteInputV1Schema>;

export const SharedSavedSecretGrantsSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: ResourceIdSchema,
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
  accountGrants: z.array(GrantIdSchema),
  teamGrants: z.array(GrantIdSchema),
  groupGrants: z.array(GrantIdSchema),
  /** Complete current E2EE recipient envelopes for the replacement audience. */
  keyEnvelopes: z.optional(z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema)),
}));

/** Internal owner repair after an audience/key change; this is not an Action. */
export const SavedSecretResourceEnvelopeRepairInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: ResourceIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
  keyEnvelopes: z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema).check(z.minLength(1)),
}));

export const SharedSavedSecretUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: ResourceIdSchema,
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
  displayName: z.string().check(z.minLength(1), z.maxLength(100)),
  kind: z.enum(['apiKey', 'token', 'password', 'other']),
  storedContent: SavedSecretResourceStoredContentV1Schema,
  /**
   * Explicit owner mode conversion (plan 10.08 §10.5/§11.0). Absent keeps the
   * resource's current mode, so rename and value rotation are unchanged; the
   * submitted `storedContent` must always match the resulting mode.
   */
  toMode: z.optional(z.enum(['plain', 'e2ee'])),
  /** Owner and current-recipient envelopes for a Plain to E2EE conversion. */
  keyEnvelopes: z.optional(z.array(SavedSecretResourceRecipientEnvelopeInputV1Schema)),
}));

export const SharedSavedSecretDeleteInputV1Schema = lazyZodSchema(() => z.strictObject({
  // Deletion is also the recovery path for retained corrupt rows, whose opaque
  // database identity must not be reinterpreted as a canonical resource id.
  resourceId: z.string(),
  expectedRevision: z.number().check(z.int()),
  expectedSettingsVersion: z.number().check(z.int(), z.nonnegative()),
  referenceCensus: SavedSecretReferenceCensusV1Schema,
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}));

export const SharedSavedSecretMutationOutputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  revision: z.number().check(z.int(), z.nonnegative()),
}));
export const SavedSecretResourceEnvelopeRepairOutputV1Schema = SharedSavedSecretMutationOutputV1Schema;
export const SharedSavedSecretPromoteOutputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceId: z.string().check(z.minLength(1)),
  settingsVersion: z.number().check(z.int(), z.nonnegative()),
  remoteHostRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
  notificationChannelRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
  catalogRevisions: z.optional(z.partial(SavedSecretCatalogRevisionsV1Schema)),
}));
export const SharedSavedSecretDeleteOutputV1Schema = lazyZodSchema(() => z.strictObject({ resourceId: z.string() }));

export const SavedSecretResourceActionErrorV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  error: z.enum([
    'invalid_resource', 'resource_not_found', 'forbidden', 'resource_changed',
    'recipient_changed', 'recipient_key_unavailable', 'invalid_cursor',
    'recipient_mode_unsupported', 'settings_conflict', 'settings_invalid', 'internal',
    'references_conflict', 'references_invalid', 'resource_in_use',
  ]),
}), z.strictObject({
  error: z.literal('managed_resources_review_required'),
  resources: z.array(ManagedResourceDependencyV1Schema),
})]));

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
} as const satisfies Readonly<Record<SharedSavedSecretActionIdV1, z.ZodMiniType>>;

export const SHARED_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 = {
  'secrets.shared.list': SharedSavedSecretListOutputV1Schema,
  'secrets.shared.create': SharedSavedSecretMutationOutputV1Schema,
  'secrets.shared.promote': SharedSavedSecretPromoteOutputV1Schema,
  'secrets.shared.grants.set': SharedSavedSecretMutationOutputV1Schema,
  'secrets.shared.update': SharedSavedSecretMutationOutputV1Schema,
  'secrets.shared.delete': SharedSavedSecretDeleteOutputV1Schema,
} as const satisfies Readonly<Record<SharedSavedSecretActionIdV1, z.ZodMiniType>>;

export type SharedSavedSecretRevealInputV1 = z.infer<typeof SharedSavedSecretRevealInputV1Schema>;

export const SharedSavedSecretRevealInputV1Schema = lazyZodSchema(() => z.strictObject({
  ref: SharedResourceReferenceSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
}));
