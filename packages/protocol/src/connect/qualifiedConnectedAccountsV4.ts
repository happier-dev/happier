import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ManagedResourceDependencyV1Schema, ManagedResourceDispositionV1Schema } from '../machines/managed/managedDependencyV1.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';

import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import {
  CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1,
} from './pluginConnectedAccountAuthenticationV2.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
} from './connectedServiceSchemas.js';
import {
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageRecordWriteFieldsV1Schema,
  ProviderAccountUsageRecordWriteV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  openProviderAccountUsageEncryptedContentV4,
  projectProviderAccountUsageSnapshotToQuotaFieldsV1,
  type ProviderAccountUsageSnapshotV1,
} from './accountUsage.js';
import {
  QualifiedConnectedAccountRefSchema,
  sameQualifiedConnectedAccountRef,
  type QualifiedConnectedAccountRef,
} from './qualifiedConnectedAccountPersistence.js';
import {
  QualifiedConnectedServiceUsageSourceV4Schema,
  ProviderAccountUsageEncryptedContentV4Schema,
  QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountConfigurationTargetV4Schema,
  QualifiedConnectedAccountGroupIncarnationV4Schema,
  QualifiedConnectedAccountGroupRefSchema,
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountConfigurationRevisionV4Schema,
  QualifiedConnectedAccountCredentialMetadataV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountModeIdV4Schema,
  QualifiedConnectedAccountPresentationMetadataV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
  QualifiedConnectedAccountProviderIdentityV4Schema,
  QualifiedConnectedAccountServiceRefSchema,
  type QualifiedConnectedAccountGroupRef,
} from './qualifiedConnectedAccountProjectionsV4.js';

export {
  QualifiedConnectedServiceUsageSourceV4Schema,
  QualifiedProviderAccountUsageRecordResponseV4Schema,
  QualifiedConnectedAccountConfigurationSnapshotV4Schema,
  QualifiedConnectedAccountConfigurationTargetV4Schema,
  QualifiedConnectedAccountCredentialMetadataV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountGroupMemberV4Schema,
  QualifiedConnectedAccountGroupIncarnationV4Schema,
  QualifiedConnectedAccountGroupRefSchema,
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountListResponseV4Schema,
  QualifiedConnectedAccountPresentationMetadataV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
  QualifiedConnectedAccountProviderIdentityV4Schema,
  QualifiedConnectedAccountServiceRefSchema,
  sameQualifiedConnectedAccountGroupRef,
  isQualifiedConnectedAccountProfileActiveV4,
  isQualifiedConnectedAccountProfileUsableV4,
  resolveQualifiedConnectedAccountGroupActiveAccountV4,
  type QualifiedConnectedAccountGroupRef,
} from './qualifiedConnectedAccountProjectionsV4.js';

export {
  QualifiedConnectedAccountIdSchema,
  QualifiedConnectedAccountRefSchema,
} from './qualifiedConnectedAccountPersistence.js';

const RevisionSchema =
  QualifiedConnectedAccountConfigurationRevisionV4Schema;
const ModeIdSchema = QualifiedConnectedAccountModeIdV4Schema;
const ModeIdZodSchema = asProtocolZod(ModeIdSchema);
const ServiceRefZodSchema = asProtocolZod(QualifiedConnectedAccountServiceRefSchema);

export const CONNECTED_ACCOUNT_V4_PROTOCOL_VERSION = 4 as const;

export const QUALIFIED_CONNECTED_ACCOUNT_V4_ROUTES = Object.freeze([
  ['GET', '/v4/connect/qualified/accounts'],
  ['POST', '/v4/connect/qualified/credential'],
  ['GET', '/v4/connect/qualified/credential'],
  ['DELETE', '/v4/connect/qualified/credential'],
  ['GET', '/v4/connect/qualified/configuration'],
  ['PATCH', '/v4/connect/qualified/configuration'],
  ['PATCH', '/v4/connect/qualified/credential/health'],
  ['POST', '/v4/connect/qualified/credential/refresh-lease'],
  ['GET', '/v4/connect/qualified/quotas'],
  ['DELETE', '/v4/connect/qualified/quotas'],
  ['POST', '/v4/connect/qualified/quotas/refresh'],
  ['GET', '/v4/connect/qualified/groups'],
  ['POST', '/v4/connect/qualified/groups'],
  ['GET', '/v4/connect/qualified/group'],
  ['PATCH', '/v4/connect/qualified/group'],
  ['DELETE', '/v4/connect/qualified/group'],
  ['PATCH', '/v4/connect/qualified/group/runtime-state'],
  ['POST', '/v4/connect/qualified/group/members'],
  ['PATCH', '/v4/connect/qualified/group/member'],
  ['DELETE', '/v4/connect/qualified/group/member'],
  ['POST', '/v4/connect/qualified/group/active-account'],
  ['GET', '/v4/connect/qualified/provider-account-usage/sources/resolve'],
  ['POST', '/v4/connect/qualified/provider-account-usage'],
  ['GET', '/v4/connect/qualified/provider-account-usage/history'],
  ['HEAD', '/v4/connect/qualified/provider-account-usage/history'],
  ['PUT', '/v4/connect/qualified/provider-account-usage/history'],
  // Automatic HEAD aliases of GET routes are not census entries.
  ['GET', '/v4/connect/qualified/provider-account-usage/history/document'],
  ['GET', '/v4/connect/qualified/provider-account-usage/record'],
  ['DELETE', '/v4/connect/qualified/provider-account-usage/record'],
  ['POST', '/v4/connect/qualified/provider-account-usage/record/refresh'],
] as const);

export const QualifiedConnectedAccountConfigurationPatchV4Schema = lazyZodSchema(() => z.strictObject({
  target: QualifiedConnectedAccountConfigurationTargetV4Schema,
  expectedConfigurationRevision: z.nullable(RevisionSchema),
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  replacementContentEnvelope: StoredJsonContentEnvelopeSchema,
}));

export const QualifiedConnectedAccountListQueryV4Schema = lazyZodSchema(() => z.strictObject({
  service: ServiceRefZodSchema,
}));

const QualifiedConnectedAccountCredentialMutationCommonV4Shape = {
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  authenticationModeId: ModeIdZodSchema,
  content: StoredJsonContentEnvelopeSchema,
  metadata: QualifiedConnectedAccountCredentialMetadataV4Schema,
  directExportContract: z.optional(z.nullable(z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1))),
  /**
   * Server-visible custody fact (ids only, no material): the Saved Secret
   * resources this credential references. Omission on an update retains the
   * stored set; legacy readers refuse a referencing credential with their
   * released typed unsupported-format result.
   */
  savedSecretResourceIds: z.optional(z.array(z.string().check(z.minLength(1), z.maxLength(128))).check(z.maxLength(64),
    z.refine(ids => new Set(ids).size === ids.length, 'Saved Secret resource ids must be unique'))),
  contributionContractVersion: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  reconnect: z.optional(z.strictObject({
    allowProviderIdentityChange: z._default(z.optional(z.boolean()), false),
  })),
  refreshLeaseOwnerId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
} as const;

export const QualifiedConnectedAccountCredentialCreateV4Schema = lazyZodSchema(() => z.strictObject({
  ...QualifiedConnectedAccountCredentialMutationCommonV4Shape,
  expectedCredentialRevision: z.null(),
  initialConfiguration: z.optional(z.strictObject({
    expectedConfigurationRevision: z.null(),
    replacementContentEnvelope: StoredJsonContentEnvelopeSchema,
  })),
}));

export const QualifiedConnectedAccountCredentialUpdateV4Schema = lazyZodSchema(() => z.strictObject({
  ...QualifiedConnectedAccountCredentialMutationCommonV4Shape,
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision: z.nullable(RevisionSchema),
}));

export const QualifiedConnectedAccountCredentialMutationV4Schema = lazyZodSchema(() => z.union([
  QualifiedConnectedAccountCredentialCreateV4Schema,
  QualifiedConnectedAccountCredentialUpdateV4Schema,
]));

export const QualifiedConnectedAccountCredentialReadV4Schema = lazyZodSchema(() => z.strictObject({
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
}));

export const QualifiedConnectedAccountCredentialDeleteV4Schema = lazyZodSchema(() => z.strictObject({
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  cleanupGroupReferences: z.boolean(),
  emergencyRevoke: z.optional(z.boolean()),
  reviewOnly: z.optional(z.boolean()),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}));

export const QualifiedConnectedAccountCredentialDeleteResponseV4Schema = lazyZodSchema(() => z.union([
  QualifiedConnectedAccountSuccessV4Schema,
  z.strictObject({ status: z.literal('ready') }),
]));

export const QualifiedConnectedAccountCredentialMutationSuccessV4Schema =
  lazyZodSchema(() => z.strictObject({
    success: z.literal(true),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    configurationRevision: z.nullable(RevisionSchema),
  }));

export const QualifiedConnectedAccountCredentialMutationSupersededV4Schema =
  lazyZodSchema(() => z.strictObject({
    error: z.literal('connect_credential_mutation_superseded'),
    reason: z.enum([
      'credential_revision_mismatch',
      'configuration_revision_mismatch',
      'refresh_lease_lost',
      'concurrent_mutation',
    ]),
    credentialRevision:
      z.nullable(ConnectedServiceCredentialRevisionV1Schema),
    configurationRevision: z.nullable(RevisionSchema),
  }));

export const QualifiedConnectedAccountCredentialErrorV4Schema = lazyZodSchema(() => z.union([
  z.strictObject({ error: z.literal('managed_resources_review_required'), resources: z.array(ManagedResourceDependencyV1Schema) }),
  z.strictObject({ error: z.literal('invalid-params') }),
  z.strictObject({ error: z.literal('connect_credential_not_found') }),
  z.strictObject({
    error: z.literal('connect_credential_unsupported_format'),
  }),
  z.strictObject({
    error: z.literal('connect_reconnect_provider_identity_mismatch'),
  }),
  z.strictObject({
    error: z.literal('connect_authentication_mode_mismatch'),
  }),
  z.strictObject({
    error: z.literal('connect_credential_referenced_by_group'),
  }),
  QualifiedConnectedAccountCredentialMutationSupersededV4Schema,
]));

export const QualifiedConnectedAccountCredentialHealthPatchV4Schema = lazyZodSchema(() => z.strictObject({
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  expectedCredentialRevision:
    ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision: z.nullable(RevisionSchema),
  health: ConnectedServiceCredentialHealthV1Schema,
}));

export const QualifiedConnectedAccountRefreshLeaseV4Schema = lazyZodSchema(() => z.strictObject({
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  expectedCredentialRevision:
    ConnectedServiceCredentialRevisionV1Schema,
  ownerId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  ttlMs: z.number().check(z.int(), z.positive(), z.maximum(86_400_000)),
}));

export const QualifiedConnectedAccountQuotaQueryV4Schema = lazyZodSchema(() => z.strictObject({
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
}));

export {
  QualifiedConnectedAccountGroupListQueryV4Schema,
  QualifiedConnectedAccountGroupCreateV4Schema,
  QualifiedConnectedAccountGroupQueryV4Schema,
  QualifiedConnectedAccountGroupPatchV4Schema,
  QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
  QualifiedConnectedAccountGroupMemberMutationV4Schema,
  QualifiedConnectedAccountGroupMemberDeleteV4Schema,
  QualifiedConnectedAccountGroupActiveAccountV4Schema,
  QualifiedConnectedAccountGroupDeleteV4Schema,
  QualifiedConnectedAccountGroupListResponseV4Schema,
  QualifiedConnectedAccountGroupResponseV4Schema,
} from './qualifiedConnectedAccountProjectionsV4.js';

export const QualifiedConnectedServiceUsageSourceResolveV4Schema =
  QualifiedConnectedServiceUsageSourceV4Schema;

export const QualifiedProviderAccountUsageWriteV4Schema = lazyZodSchema(() => z.strictObject({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  expectedCredentialRevision:
    ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision: z.nullable(RevisionSchema),
  ...ProviderAccountUsageRecordWriteFieldsV1Schema.shape,
}).check(z.superRefine((write, context) => {
  const {
    source: _source,
    expectedCredentialRevision: _expectedCredentialRevision,
    expectedConfigurationRevision: _expectedConfigurationRevision,
    ...recordWrite
  } = write;
  const parsed = ProviderAccountUsageRecordWriteV1Schema.safeParse(recordWrite);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({
      ...issue,
      path: issue.path,
    });
  }
})));

export const QualifiedProviderAccountUsageRecordQueryV4Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema,
}));

export const QualifiedProviderAccountUsageReadErrorV4Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('provider_account_usage_storage_mode_mismatch'),
}));

export const QualifiedConnectedAccountSuccessV4Schema = lazyZodSchema(() => z.strictObject({
  success: z.literal(true),
}));

export const QualifiedConnectedAccountRefreshLeaseResponseV4Schema = lazyZodSchema(() => z.strictObject({
  acquired: z.boolean(),
  leaseUntil: z.number().check(z.int(), z.nonnegative()),
  ownerId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
}));

export const QualifiedConnectedAccountQuotaSnapshotV4Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ConnectedServiceQuotaSnapshotV1Schema, { serviceId: true, profileId: true }), { ref: asProtocolZod(QualifiedConnectedAccountRefSchema) })));

export const QualifiedConnectedServiceUsageSourceResolutionV4Schema = lazyZodSchema(() => z.strictObject({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  recordId: ProviderAccountUsageRecordIdSchema,
  providerAccountId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  fetchedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
  staleAfterMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));

export const QualifiedConnectedAccountQuotaResponseV4Schema = lazyZodSchema(() => z.strictObject({
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  sourceResolution:
    QualifiedConnectedServiceUsageSourceResolutionV4Schema,
  content: z.discriminatedUnion('t', [
    z.strictObject({
      t: z.literal('plain'),
      v: QualifiedConnectedAccountQuotaSnapshotV4Schema,
    }),
    ProviderAccountUsageEncryptedContentV4Schema,
  ]),
  metadata: z.strictObject({
    fetchedAt: z.number().check(z.int(), z.nonnegative()),
    staleAfterMs: z.number().check(z.int(), z.nonnegative()),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  }),
}));

export type QualifiedConnectedAccountQuotaSnapshotV4 = z.infer<
  typeof QualifiedConnectedAccountQuotaSnapshotV4Schema
>;
export type QualifiedConnectedAccountQuotaResponseV4 = z.infer<
  typeof QualifiedConnectedAccountQuotaResponseV4Schema
>;
export type QualifiedConnectedServiceUsageSourceResolutionV4 = z.infer<
  typeof QualifiedConnectedServiceUsageSourceResolutionV4Schema
>;

function sourceResolutionMatchesQuotaResponse(
  response: QualifiedConnectedAccountQuotaResponseV4,
  expectedRef: QualifiedConnectedAccountRef,
): boolean {
  const resolution = response.sourceResolution;
  if (
    !sameQualifiedConnectedAccountRef(
      resolution.source.ref,
      expectedRef,
    )
    || response.metadata.fetchedAt
      !== (resolution.fetchedAt ?? 0)
    || response.metadata.staleAfterMs
      !== (resolution.staleAfterMs ?? 0)
  ) {
    return false;
  }
  if (response.content.t === 'encrypted') return true;
  return sameQualifiedConnectedAccountRef(
    response.content.v.ref,
    expectedRef,
  )
    && response.content.v.activeAccountId
      === resolution.providerAccountId
    && response.content.v.fetchedAt
      === response.metadata.fetchedAt
    && response.content.v.staleAfterMs
      === response.metadata.staleAfterMs;
}

export function projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4(
  params: Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1;
    ref: QualifiedConnectedAccountRef;
  }>,
): QualifiedConnectedAccountQuotaSnapshotV4 {
  return QualifiedConnectedAccountQuotaSnapshotV4Schema.parse({
    ...projectProviderAccountUsageSnapshotToQuotaFieldsV1(params.snapshot),
    ref: QualifiedConnectedAccountRefSchema.parse(params.ref),
  });
}

/**
 * Opens either qualified quota content mode through the canonical PAU codec.
 * The requested identity is required so a valid response for another account
 * cannot be rendered under the caller's account.
 */
export function openQualifiedConnectedAccountQuotaResponseV4(
  params: Readonly<{
    response: QualifiedConnectedAccountQuotaResponseV4;
    expectedRef: QualifiedConnectedAccountRef;
    material?: AccountScopedCryptoMaterial | null;
  }>,
): QualifiedConnectedAccountQuotaSnapshotV4 | null {
  const response =
    QualifiedConnectedAccountQuotaResponseV4Schema.safeParse(
      params.response,
    );
  const expectedRef =
    QualifiedConnectedAccountRefSchema.safeParse(params.expectedRef);
  if (
    !response.success
    || !expectedRef.success
    || !sameQualifiedConnectedAccountRef(
      response.data.ref,
      expectedRef.data,
    )
    || !sourceResolutionMatchesQuotaResponse(
      response.data,
      expectedRef.data,
    )
  ) {
    return null;
  }
  if (response.data.content.t === 'plain') {
    return response.data.content.v;
  }
  if (!params.material) return null;
  const snapshot = openProviderAccountUsageEncryptedContentV4({
    material: params.material,
    content: response.data.content,
  });
  if (
    !snapshot
    || snapshot.recordId
      !== response.data.sourceResolution.recordId
    || snapshot.recordKey.accountSubjectId
      !== response.data.sourceResolution.providerAccountId
    || snapshot.fetchedAtMs
      !== response.data.metadata.fetchedAt
    || snapshot.staleAfterMs
      !== response.data.metadata.staleAfterMs
  ) {
    return null;
  }
  return projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
    snapshot,
    ref: expectedRef.data,
  });
}

export const QualifiedProviderAccountUsageSourceLinkOutcomeV4Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('linked') }),
  z.strictObject({
    status: z.literal('skipped'),
    reason: z.enum(['binding_unavailable', 'ownership_unproven']),
  }),
]));

export const QualifiedProviderAccountUsageWriteSuccessV4Schema = lazyZodSchema(() => z.strictObject({
  success: z.literal(true),
  source: z.optional(QualifiedProviderAccountUsageSourceLinkOutcomeV4Schema),
}));

/**
 * `sources` is derived, not independently sized: one entry per account binding plus
 * one per group membership that resolves to the same Provider subject. Its size
 * therefore follows the credential and group capacities, and it carries no bound of
 * its own — the record GET, DELETE and refresh owners all read this array, so a
 * bound here would make a stored record unreadable through its own routes.
 */
export type QualifiedConnectedAccountServiceRef = PluginContributionIdentityV1;
export type QualifiedConnectedAccountConfigurationTargetV4 = z.infer<
  typeof QualifiedConnectedAccountConfigurationTargetV4Schema
>;
export type QualifiedConnectedAccountConfigurationPatchV4 = z.infer<
  typeof QualifiedConnectedAccountConfigurationPatchV4Schema
>;
export type QualifiedConnectedAccountConfigurationSnapshotV4 = z.infer<
  typeof QualifiedConnectedAccountConfigurationSnapshotV4Schema
>;
export type QualifiedConnectedAccountCredentialMetadataV4 = z.infer<
  typeof QualifiedConnectedAccountCredentialMetadataV4Schema
>;
export type QualifiedConnectedAccountCredentialSnapshotV4 = z.infer<
  typeof QualifiedConnectedAccountCredentialSnapshotV4Schema
>;
export type QualifiedConnectedAccountProfileV4 = z.infer<
  typeof QualifiedConnectedAccountProfileV4Schema
>;
/**
 * The group row id is the immutable lifetime token for a logical group ref.
 * Keep it explicit in the exported V4 projection type so V4 mutation callers
 * cannot accidentally treat a recreated group as the prior incarnation.
 */
export type QualifiedConnectedAccountGroupV4 = z.infer<
  typeof QualifiedConnectedAccountGroupV4Schema
> & Readonly<{
  incarnation: z.infer<typeof QualifiedConnectedAccountGroupIncarnationV4Schema>;
}>;

export type QualifiedConnectedServiceUsageSourceV4 = z.infer<
  typeof QualifiedConnectedServiceUsageSourceV4Schema
>;
