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

export const QualifiedConnectedAccountConfigurationRevisionV4Schema = z
  .string()
  .trim()
  .min(1)
  .max(128);

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

export const QualifiedConnectedAccountGroupRefSchema = z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
}).strict();

/**
 * Opaque identity of one persisted group lifetime. Unlike generation and
 * runtime-state revision, it does not reset when a logical group id is
 * deleted and recreated.
 */
export const QualifiedConnectedAccountGroupIncarnationV4Schema = z
  .string()
  .trim()
  .min(1)
  .max(128);

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

export const QualifiedConnectedAccountListResponseV4Schema = z.object({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  accounts: z.array(QualifiedConnectedAccountProfileV4Schema).max(500),
}).strict();

export const QualifiedConnectedAccountConfigurationTargetV4Schema = z.object({
  kind: z.literal('account'),
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
}).strict();

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

export const QualifiedConnectedAccountGroupMemberV4Schema = z.object({
  v: z.literal(1),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
  state: ConnectedServiceAuthGroupMemberStateV1Schema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const QualifiedConnectedAccountGroupV4Schema = z.object({
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
}).strict();
