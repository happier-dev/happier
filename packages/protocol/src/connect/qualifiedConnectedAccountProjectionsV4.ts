import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceAuthGroupMemberStateV1Schema,
  ConnectedServiceAuthGroupPolicyV1Schema,
  ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  ConnectedServiceAuthGroupStateV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
} from './connectedServiceSchemas.js';
import {
  QualifiedConnectedAccountIdSchema,
  QualifiedConnectedAccountRefSchema,
} from './qualifiedConnectedAccountPersistence.js';

export const QualifiedConnectedAccountConfigurationRevisionV4Schema = lazyZodSchema(() => z
  .string()
  .trim()
  .min(1)
  .max(128));

export const QualifiedConnectedAccountModeIdV4Schema =
  PluginContributionLocalIdSchema;
const QualifiedConnectedAccountModeIdV4ZodSchema = asProtocolZod(
  QualifiedConnectedAccountModeIdV4Schema,
);

const QualifiedConnectedAccountRevisionedV4Shape = {
  revisionSemantics: z.literal('revisioned'),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
} as const;

const QualifiedConnectedAccountLegacyUnfencedV4Shape = {
  revisionSemantics: z.literal('legacy_unfenced'),
  credentialRevision: z.null(),
} as const;

/**
 * V4 read projections publish the credential revision as a discriminated
 * authority boundary. A legacy stored row remains observable, but it cannot
 * supply a CAS/currentness token to any consumer.
 */
function createQualifiedConnectedAccountRevisionSemanticsV4Schema<
  Shape extends z.ZodRawShape,
>(shape: Shape) {
  return z.discriminatedUnion('revisionSemantics', [
    z.object({
      ...shape,
      ...QualifiedConnectedAccountRevisionedV4Shape,
    }).strict(),
    z.object({
      ...shape,
      ...QualifiedConnectedAccountLegacyUnfencedV4Shape,
    }).strict(),
  ]);
}

export const QualifiedConnectedAccountServiceRefSchema = PluginContributionIdentityV1Schema;
const QualifiedConnectedAccountServiceRefZodSchema = asProtocolZod(
  QualifiedConnectedAccountServiceRefSchema,
);

export const QualifiedConnectedAccountGroupRefSchema = lazyZodSchema(() => z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
}).strict());

/**
 * Opaque identity of one persisted group lifetime. Unlike generation and
 * runtime-state revision, it does not reset when a logical group id is
 * deleted and recreated.
 */
export const QualifiedConnectedAccountGroupIncarnationV4Schema = lazyZodSchema(() => z
  .string()
  .trim()
  .min(1)
  .max(128));

export const QualifiedConnectedAccountProviderIdentityV4Schema = lazyZodSchema(() => z.object({
  accountId: z.string().trim().min(1).max(256).nullable().optional(),
  email: z.string().trim().min(1).max(512).nullable().optional(),
}).strict());

const QualifiedConnectedAccountScopesV4Schema = lazyZodSchema(() => z
  .array(z.string().trim().min(1).max(256))
  .max(128)
  .refine(
    (scopes) => new Set(scopes).size === scopes.length,
    'Qualified Connected Account scopes must be unique',
  )
  .default([]));

export const QualifiedConnectedAccountPresentationMetadataV4Schema = lazyZodSchema(() => z.object({
  providerIdentity: QualifiedConnectedAccountProviderIdentityV4Schema.optional(),
  displayName: z.string().trim().min(1).max(512).optional(),
  scopes: QualifiedConnectedAccountScopesV4Schema,
}).strict());

const QualifiedConnectedAccountProfileV4Shape = {
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  status: z.enum([
    'connected',
    'refreshing',
    'needs_reauth',
    'refresh_failed_retryable',
  ]),
  authenticationModeId: QualifiedConnectedAccountModeIdV4ZodSchema.nullable(),
  configurationReady: z.boolean(),
  configurationRevision:
    QualifiedConnectedAccountConfigurationRevisionV4Schema.nullable(),
  kind: z.enum(['oauth', 'token']).nullable().optional(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
  lastUsedAt: z.number().int().nonnegative().nullable().optional(),
  ...QualifiedConnectedAccountPresentationMetadataV4Schema.shape,
} as const;

export const QualifiedConnectedAccountProfileV4Schema =
  createQualifiedConnectedAccountRevisionSemanticsV4Schema(
    QualifiedConnectedAccountProfileV4Shape,
  );

/** Every account the Account holds for the service. */
export const QualifiedConnectedAccountListResponseV4Schema = lazyZodSchema(() => z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  accounts: z.array(QualifiedConnectedAccountProfileV4Schema),
}).strict());

export const QualifiedConnectedAccountConfigurationTargetV4Schema = lazyZodSchema(() => z.object({
  kind: z.literal('account'),
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
}).strict());

export const QualifiedConnectedAccountCredentialMetadataV4Schema =
  QualifiedConnectedAccountPresentationMetadataV4Schema;

export const QualifiedConnectedAccountConfigurationSnapshotV4Schema =
  createQualifiedConnectedAccountRevisionSemanticsV4Schema({
    target: QualifiedConnectedAccountConfigurationTargetV4Schema,
    authenticationModeId: QualifiedConnectedAccountModeIdV4ZodSchema.nullable(),
    configurationRevision:
      QualifiedConnectedAccountConfigurationRevisionV4Schema,
    configurationContent: StoredJsonContentEnvelopeSchema,
  });

export const QualifiedConnectedAccountCredentialSnapshotV4Schema =
  createQualifiedConnectedAccountRevisionSemanticsV4Schema({
    ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
    authenticationModeId: QualifiedConnectedAccountModeIdV4ZodSchema.nullable(),
    configurationRevision:
      QualifiedConnectedAccountConfigurationRevisionV4Schema.nullable(),
    content: StoredJsonContentEnvelopeSchema,
    metadata: QualifiedConnectedAccountCredentialMetadataV4Schema,
  });

export const QualifiedConnectedAccountGroupMemberV4Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  state: ConnectedServiceAuthGroupMemberStateV1Schema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict());

export const QualifiedConnectedAccountGroupV4Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  ref: QualifiedConnectedAccountGroupRefSchema,
  incarnation: QualifiedConnectedAccountGroupIncarnationV4Schema,
  displayName: z.string().trim().min(1).nullable(),
  policy: ConnectedServiceAuthGroupPolicyV1Schema,
  activeConnectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema).nullable(),
  generation: z.number().int().nonnegative(),
  runtimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  state: ConnectedServiceAuthGroupStateV1Schema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  members: z.array(QualifiedConnectedAccountGroupMemberV4Schema).default([]),
}).strict());

export const QualifiedConnectedAccountGroupListQueryV4Schema = lazyZodSchema(() => z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
}).strict());

export const QualifiedConnectedAccountGroupCreateV4Schema = lazyZodSchema(() => z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  group: z.object({
    groupId: ConnectedServiceAuthGroupIdSchema,
    displayName: z.string().trim().min(1).max(512).nullable().optional(),
    state: ConnectedServiceAuthGroupStateV1Schema.optional(),
    policy: ConnectedServiceAuthGroupPolicyV1Schema.optional(),
  }).strict(),
}).strict());

export const QualifiedConnectedAccountGroupQueryV4Schema = lazyZodSchema(() => z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
}).strict());

export const QualifiedConnectedAccountGroupPatchV4Schema = lazyZodSchema(() => z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedGeneration: z.number().int().nonnegative(),
  expectedIncarnation:
    QualifiedConnectedAccountGroupIncarnationV4Schema.optional(),
  displayName: z.string().trim().min(1).max(512).nullable().optional(),
  state: ConnectedServiceAuthGroupStateV1Schema.removeDefault().optional(),
  policy: ConnectedServiceAuthGroupPolicyV1Schema.optional(),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
  overrideRuntimeCooldown: z.boolean().optional(),
}).strict());

export const QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema = lazyZodSchema(() => z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedGeneration: z.number().int().nonnegative(),
  expectedIncarnation:
    QualifiedConnectedAccountGroupIncarnationV4Schema.optional(),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  runtimeState: z.object({
    state: ConnectedServiceAuthGroupStateV1Schema.removeDefault().optional(),
    memberStates: z.array(z.object({
      connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
      state: ConnectedServiceAuthGroupMemberStateV1Schema,
    }).strict()).default([]),
  }).strict(),
}).strict());

export const QualifiedConnectedAccountGroupMemberMutationV4Schema = lazyZodSchema(() => z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedGeneration: z.number().int().nonnegative(),
  expectedIncarnation:
    QualifiedConnectedAccountGroupIncarnationV4Schema.optional(),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
  state:
    ConnectedServiceAuthGroupMemberStateV1Schema.removeDefault().optional(),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
}).strict());

export const QualifiedConnectedAccountGroupMemberDeleteV4Schema = lazyZodSchema(() => z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedGeneration: z.number().int().nonnegative(),
  expectedIncarnation:
    QualifiedConnectedAccountGroupIncarnationV4Schema.optional(),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
}).strict());

export const QualifiedConnectedAccountGroupActiveAccountV4Schema = lazyZodSchema(() => z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedIncarnation:
    QualifiedConnectedAccountGroupIncarnationV4Schema.optional(),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  expectedGeneration: z.number().int().nonnegative(),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
  expectedSource: z.object({
    connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    configurationRevision: QualifiedConnectedAccountConfigurationRevisionV4Schema.nullable(),
  }).strict().optional(),
  overrideRuntimeCooldown: z.boolean().optional(),
}).strict());

export const QualifiedConnectedAccountGroupDeleteV4Schema = lazyZodSchema(() => z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedGeneration: z.number().int().nonnegative(),
  expectedIncarnation: QualifiedConnectedAccountGroupIncarnationV4Schema,
  expectedRuntimeStateRevision:
    ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema.optional(),
}).strict());

/** Every group the Account holds. */
export const QualifiedConnectedAccountGroupListResponseV4Schema = lazyZodSchema(() => z.object({
  groups: z.array(QualifiedConnectedAccountGroupV4Schema),
}).strict());

export const QualifiedConnectedAccountGroupResponseV4Schema = lazyZodSchema(() => z.object({
  group: QualifiedConnectedAccountGroupV4Schema,
}).strict());
