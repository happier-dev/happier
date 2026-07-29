import { z } from 'zod';

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceAuthGroupPolicyV1Schema,
  ConnectedServiceAuthGroupMemberStateV1Schema,
  ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  ConnectedServiceAuthGroupStateV1Schema,
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
} from './connectedServiceSchemas.js';
import {
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageRecordWriteFieldsV1Schema,
  ProviderAccountUsageRecordWriteV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  openProviderAccountUsageSnapshotCiphertext,
  projectProviderAccountUsageSnapshotToQuotaFieldsV1,
  type ProviderAccountUsageSnapshotV1,
} from './accountUsage.js';
import {
  QualifiedConnectedAccountIdSchema,
  QualifiedConnectedAccountRefSchema,
  type QualifiedConnectedAccountRef,
} from './qualifiedConnectedAccountPersistence.js';

export {
  QualifiedConnectedAccountIdSchema,
  QualifiedConnectedAccountRefSchema,
} from './qualifiedConnectedAccountPersistence.js';

const RevisionSchema = z.string().trim().min(1).max(128);
const ModeIdSchema = PluginContributionLocalIdSchema;

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
  ['GET', '/v4/connect/qualified/provider-account-usage/record'],
  ['DELETE', '/v4/connect/qualified/provider-account-usage/record'],
  ['POST', '/v4/connect/qualified/provider-account-usage/record/refresh'],
] as const);

export const QualifiedConnectedAccountServiceRefSchema = PluginContributionIdentityV1Schema;

export const QualifiedConnectedAccountGroupRefSchema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
}).strict();

export const QualifiedConnectedAccountConfigurationTargetV4Schema = z.object({
  kind: z.literal('account'),
  ref: QualifiedConnectedAccountRefSchema,
}).strict();

export const QualifiedConnectedAccountConfigurationPatchV4Schema = z.object({
  target: QualifiedConnectedAccountConfigurationTargetV4Schema,
  expectedConfigurationRevision: RevisionSchema.nullable(),
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  replacementContentEnvelope: StoredJsonContentEnvelopeSchema,
  preserveConfigurationRevisionForCiphertextReseal:
    z.literal(true).optional(),
}).strict();

export const QualifiedConnectedAccountConfigurationSnapshotV4Schema = z.object({
  target: QualifiedConnectedAccountConfigurationTargetV4Schema,
  authenticationModeId: ModeIdSchema.nullable(),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  configurationRevision: RevisionSchema,
  configurationContent: StoredJsonContentEnvelopeSchema,
}).strict();

export const QualifiedConnectedAccountListQueryV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
}).strict();

export const QualifiedConnectedAccountProviderIdentityV4Schema = z.object({
  accountId: z.string().trim().min(1).max(256).nullable().optional(),
  email: z.string().trim().min(1).max(512).nullable().optional(),
}).strict();

const QualifiedConnectedAccountScopesV4Schema = z
  .array(z.string().trim().min(1).max(256))
  .max(128)
  .refine(
    (scopes) => new Set(scopes).size === scopes.length,
    'Qualified Connected Account scopes must be unique',
  )
  .default([]);

export const QualifiedConnectedAccountPresentationMetadataV4Schema = z.object({
  providerIdentity: QualifiedConnectedAccountProviderIdentityV4Schema.optional(),
  displayName: z.string().trim().min(1).max(512).optional(),
  scopes: QualifiedConnectedAccountScopesV4Schema,
}).strict();

export const QualifiedConnectedAccountProfileV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
  status: z.enum([
    'connected',
    'refreshing',
    'needs_reauth',
    'refresh_failed_retryable',
  ]),
  authenticationModeId: ModeIdSchema.nullable(),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  configurationReady: z.boolean(),
  configurationRevision: RevisionSchema.nullable(),
  kind: z.enum(['oauth', 'token']).nullable().optional(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
  lastUsedAt: z.number().int().nonnegative().nullable().optional(),
}).extend(QualifiedConnectedAccountPresentationMetadataV4Schema.shape).strict();

export const QualifiedConnectedAccountListResponseV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
  accounts: z.array(QualifiedConnectedAccountProfileV4Schema).max(500),
}).strict();

export const QualifiedConnectedAccountCredentialMetadataV4Schema =
  QualifiedConnectedAccountPresentationMetadataV4Schema;

const QualifiedConnectedAccountCredentialMutationCommonV4Shape = {
  ref: QualifiedConnectedAccountRefSchema,
  authenticationModeId: ModeIdSchema,
  content: StoredJsonContentEnvelopeSchema,
  metadata: QualifiedConnectedAccountCredentialMetadataV4Schema,
  reconnect: z.object({
    allowProviderIdentityChange: z.boolean().optional().default(false),
  }).strict().optional(),
  refreshLeaseOwnerId: z.string().trim().min(1).max(256).optional(),
} as const;

export const QualifiedConnectedAccountCredentialCreateV4Schema = z.object({
  ...QualifiedConnectedAccountCredentialMutationCommonV4Shape,
  expectedCredentialRevision: z.null(),
  initialConfiguration: z.object({
    expectedConfigurationRevision: z.null(),
    replacementContentEnvelope: StoredJsonContentEnvelopeSchema,
  }).strict().optional(),
}).strict();

export const QualifiedConnectedAccountCredentialUpdateV4Schema = z.object({
  ...QualifiedConnectedAccountCredentialMutationCommonV4Shape,
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision: RevisionSchema.nullable(),
}).strict();

export const QualifiedConnectedAccountCredentialMutationV4Schema = z.union([
  QualifiedConnectedAccountCredentialCreateV4Schema,
  QualifiedConnectedAccountCredentialUpdateV4Schema,
]);

export const QualifiedConnectedAccountCredentialReadV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
}).strict();

export const QualifiedConnectedAccountCredentialDeleteV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  cleanupGroupReferences: z.boolean(),
}).strict();

export const QualifiedConnectedAccountCredentialSnapshotV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
  authenticationModeId: ModeIdSchema.nullable(),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  configurationRevision: RevisionSchema.nullable(),
  content: StoredJsonContentEnvelopeSchema,
  metadata: QualifiedConnectedAccountCredentialMetadataV4Schema,
}).strict();

export const QualifiedConnectedAccountCredentialMutationSuccessV4Schema =
  z.object({
    success: z.literal(true),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    configurationRevision: RevisionSchema.nullable(),
  }).strict();

export const QualifiedConnectedAccountCredentialMutationSupersededV4Schema =
  z.object({
    error: z.literal('connect_credential_mutation_superseded'),
    reason: z.enum([
      'credential_revision_mismatch',
      'configuration_revision_mismatch',
      'refresh_lease_lost',
      'concurrent_mutation',
    ]),
    credentialRevision:
      ConnectedServiceCredentialRevisionV1Schema.nullable(),
    configurationRevision: RevisionSchema.nullable(),
  }).strict();

export const QualifiedConnectedAccountCredentialErrorV4Schema = z.union([
  z.object({ error: z.literal('invalid-params') }).strict(),
  z.object({ error: z.literal('connect_credential_not_found') }).strict(),
  z.object({
    error: z.literal('connect_reconnect_provider_identity_mismatch'),
  }).strict(),
  z.object({
    error: z.literal('connect_authentication_mode_mismatch'),
  }).strict(),
  z.object({
    error: z.literal('connect_credential_referenced_by_group'),
  }).strict(),
  QualifiedConnectedAccountCredentialMutationSupersededV4Schema,
]);

export const QualifiedConnectedAccountCredentialHealthPatchV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
  expectedCredentialRevision:
    ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision: RevisionSchema.nullable(),
  health: ConnectedServiceCredentialHealthV1Schema,
}).strict();

export const QualifiedConnectedAccountRefreshLeaseV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
  expectedCredentialRevision:
    ConnectedServiceCredentialRevisionV1Schema,
  ownerId: z.string().trim().min(1).max(256),
  ttlMs: z.number().int().positive().max(86_400_000),
}).strict();

export const QualifiedConnectedAccountQuotaQueryV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
}).strict();

export const QualifiedConnectedAccountGroupListQueryV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
}).strict();

export const QualifiedConnectedAccountGroupCreateV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
  group: z.object({
    groupId: ConnectedServiceAuthGroupIdSchema,
    displayName: z.string().trim().min(1).max(512).nullable().optional(),
    state: ConnectedServiceAuthGroupStateV1Schema.optional(),
    policy: ConnectedServiceAuthGroupPolicyV1Schema.optional(),
  }).strict(),
}).strict();

export const QualifiedConnectedAccountGroupQueryV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
}).strict();

export const QualifiedConnectedAccountGroupPatchV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  displayName: z.string().trim().min(1).max(512).nullable().optional(),
  state: ConnectedServiceAuthGroupStateV1Schema.removeDefault().optional(),
  policy: ConnectedServiceAuthGroupPolicyV1Schema.optional(),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
  overrideRuntimeCooldown: z.boolean().optional(),
}).strict();

export const QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  runtimeState: z.object({
    state: ConnectedServiceAuthGroupStateV1Schema.removeDefault().optional(),
    memberStates: z.array(z.object({
      connectedAccountId: QualifiedConnectedAccountIdSchema,
      state: ConnectedServiceAuthGroupMemberStateV1Schema,
    }).strict()).default([]),
  }).strict(),
}).strict();

export const QualifiedConnectedAccountGroupMemberMutationV4Schema = z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  connectedAccountId: QualifiedConnectedAccountIdSchema,
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  state:
    ConnectedServiceAuthGroupMemberStateV1Schema.removeDefault().optional(),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
}).strict();

export const QualifiedConnectedAccountGroupMemberDeleteV4Schema = z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  connectedAccountId: QualifiedConnectedAccountIdSchema,
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
}).strict();

export const QualifiedConnectedAccountGroupActiveAccountV4Schema = z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  connectedAccountId: QualifiedConnectedAccountIdSchema,
  expectedGeneration: z.number().int().nonnegative().optional(),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
  expectedSource: z.object({
    connectedAccountId: QualifiedConnectedAccountIdSchema,
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    configurationRevision: RevisionSchema.nullable(),
  }).strict().optional(),
  overrideRuntimeCooldown: z.boolean().optional(),
}).strict();

export const QualifiedConnectedAccountGroupMemberV4Schema = z.object({
  v: z.literal(1),
  connectedAccountId: QualifiedConnectedAccountIdSchema,
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  state: ConnectedServiceAuthGroupMemberStateV1Schema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const QualifiedConnectedAccountGroupV4Schema = z.object({
  v: z.literal(1),
  ref: QualifiedConnectedAccountGroupRefSchema,
  displayName: z.string().trim().min(1).nullable(),
  policy: ConnectedServiceAuthGroupPolicyV1Schema,
  activeConnectedAccountId: QualifiedConnectedAccountIdSchema.nullable(),
  generation: z.number().int().nonnegative(),
  runtimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  state: ConnectedServiceAuthGroupStateV1Schema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  members: z.array(QualifiedConnectedAccountGroupMemberV4Schema).default([]),
}).strict();

export const QualifiedConnectedAccountGroupListResponseV4Schema = z.object({
  groups: z.array(QualifiedConnectedAccountGroupV4Schema).max(500),
}).strict();

export const QualifiedConnectedAccountGroupResponseV4Schema = z.object({
  group: QualifiedConnectedAccountGroupV4Schema,
}).strict();

export const QualifiedConnectedServiceUsageSourceV4Schema = z.discriminatedUnion('bindingKind', [
  z.object({
    ref: QualifiedConnectedAccountRefSchema,
    bindingKind: z.literal('account'),
  }).strict(),
  z.object({
    ref: QualifiedConnectedAccountRefSchema,
    bindingKind: z.literal('group_member'),
    groupId: ConnectedServiceAuthGroupIdSchema,
    groupGeneration: z.number().int().nonnegative().optional(),
  }).strict(),
]);

export const QualifiedConnectedServiceUsageSourceResolveV4Schema =
  QualifiedConnectedServiceUsageSourceV4Schema;

export const QualifiedProviderAccountUsageWriteV4Schema = z.object({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  expectedCredentialRevision:
    ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision: RevisionSchema.nullable(),
  ...ProviderAccountUsageRecordWriteFieldsV1Schema.shape,
}).strict().superRefine((write, context) => {
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
});

export const QualifiedProviderAccountUsageRecordQueryV4Schema = z.object({
  recordId: ProviderAccountUsageRecordIdSchema,
}).strict();

export const QualifiedConnectedAccountSuccessV4Schema = z.object({
  success: z.literal(true),
}).strict();

export const QualifiedConnectedAccountRefreshLeaseResponseV4Schema = z.object({
  acquired: z.boolean(),
  leaseUntil: z.number().int().nonnegative(),
  ownerId: z.string().trim().min(1).max(256),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
}).strict();

export const QualifiedConnectedAccountQuotaSnapshotV4Schema =
  ConnectedServiceQuotaSnapshotV1Schema
    .omit({ serviceId: true, profileId: true })
    .extend({ ref: QualifiedConnectedAccountRefSchema })
    .strict();

export const QualifiedConnectedServiceUsageSourceResolutionV4Schema = z.object({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  recordId: ProviderAccountUsageRecordIdSchema,
  providerAccountId: z.string().trim().min(1).max(512),
  fetchedAt: z.number().int().nonnegative().nullable(),
  staleAfterMs: z.number().int().nonnegative().nullable(),
}).strict();

export const QualifiedConnectedAccountQuotaResponseV4Schema = z.object({
  ref: QualifiedConnectedAccountRefSchema,
  sourceResolution:
    QualifiedConnectedServiceUsageSourceResolutionV4Schema,
  content: z.discriminatedUnion('t', [
    z.object({
      t: z.literal('plain'),
      v: QualifiedConnectedAccountQuotaSnapshotV4Schema,
    }).strict(),
    z.object({
      t: z.literal('encrypted'),
      c: z.string().min(1),
    }).strict(),
  ]),
  metadata: z.object({
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().nonnegative(),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export type QualifiedConnectedAccountQuotaSnapshotV4 = z.infer<
  typeof QualifiedConnectedAccountQuotaSnapshotV4Schema
>;
export type QualifiedConnectedAccountQuotaResponseV4 = z.infer<
  typeof QualifiedConnectedAccountQuotaResponseV4Schema
>;
export type QualifiedConnectedServiceUsageSourceResolutionV4 = z.infer<
  typeof QualifiedConnectedServiceUsageSourceResolutionV4Schema
>;

function sameQualifiedConnectedAccountRef(
  left: QualifiedConnectedAccountRef,
  right: QualifiedConnectedAccountRef,
): boolean {
  return left.service.pluginId === right.service.pluginId
    && left.service.localId === right.service.localId
    && left.accountId === right.accountId;
}

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
    material: AccountScopedCryptoMaterial;
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
  const opened = openProviderAccountUsageSnapshotCiphertext({
    material: params.material,
    ciphertext: response.data.content.c,
  });
  const snapshot =
    ProviderAccountUsageSnapshotV1Schema.safeParse(opened?.value);
  if (
    !snapshot.success
    || snapshot.data.recordId
      !== response.data.sourceResolution.recordId
    || snapshot.data.recordKey.accountSubjectId
      !== response.data.sourceResolution.providerAccountId
    || snapshot.data.fetchedAtMs
      !== response.data.metadata.fetchedAt
    || snapshot.data.staleAfterMs
      !== response.data.metadata.staleAfterMs
  ) {
    return null;
  }
  return projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
    snapshot: snapshot.data,
    ref: expectedRef.data,
  });
}

export const QualifiedProviderAccountUsageSourceLinkOutcomeV4Schema = z.union([
  z.object({ status: z.literal('linked') }).strict(),
  z.object({
    status: z.literal('skipped'),
    reason: z.enum(['binding_unavailable', 'ownership_unproven']),
  }).strict(),
]);

export const QualifiedProviderAccountUsageWriteSuccessV4Schema = z.object({
  success: z.literal(true),
  source: QualifiedProviderAccountUsageSourceLinkOutcomeV4Schema.optional(),
}).strict();

export const QualifiedProviderAccountUsageRecordResponseV4Schema = z.object({
  content: StoredJsonContentEnvelopeSchema,
  metadata: z.object({
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().nonnegative(),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
  }).strict(),
  sources: z.array(QualifiedConnectedServiceUsageSourceV4Schema).max(500),
}).strict();

export type QualifiedConnectedAccountServiceRef = z.infer<
  typeof QualifiedConnectedAccountServiceRefSchema
>;
export type QualifiedConnectedAccountGroupRef = z.infer<
  typeof QualifiedConnectedAccountGroupRefSchema
>;
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
export type QualifiedConnectedAccountGroupV4 = z.infer<
  typeof QualifiedConnectedAccountGroupV4Schema
>;
export type QualifiedConnectedServiceUsageSourceV4 = z.infer<
  typeof QualifiedConnectedServiceUsageSourceV4Schema
>;
