import { z } from 'zod';

import { canonicalBoundedRecordKeySchema } from '../../common/canonicalRecordKey.js';
import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposes.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginPermissionCapabilityV1Schema } from './capabilityV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const LowercaseSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const PluginCredentialAccessSlotIdSchema = canonicalBoundedRecordKeySchema(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .brand<'PluginCredentialAccessSlotId'>();
export type PluginCredentialAccessSlotId = z.infer<typeof PluginCredentialAccessSlotIdSchema>;

export const CredentialAccessDeclarationDigestSchema = LowercaseSha256DigestSchema
  .brand<'CredentialAccessDeclarationDigest'>();
export type CredentialAccessDeclarationDigest = z.infer<typeof CredentialAccessDeclarationDigestSchema>;

/**
 * Domain-separated digest of the Account Settings authority selected for one
 * raw credential disclosure. It never carries secret or token material.
 */
export const CredentialAccessSelectedAuthorityDigestSchema = LowercaseSha256DigestSchema
  .brand<'CredentialAccessSelectedAuthorityDigest'>();
export type CredentialAccessSelectedAuthorityDigest = z.infer<
  typeof CredentialAccessSelectedAuthorityDigestSchema
>;

/** Domain-separated digest of one exact raw realm/phase/request tuple. */
export const CredentialAccessSelectedRawAccessDigestSchema = LowercaseSha256DigestSchema
  .brand<'CredentialAccessSelectedRawAccessDigest'>();
export type CredentialAccessSelectedRawAccessDigest = z.infer<
  typeof CredentialAccessSelectedRawAccessDigestSchema
>;

/** Exact immutable runtime generation that admitted this raw-credential authority. */
export const PluginPermissionInstalledGenerationIdSchema = z.string().trim().min(1).max(512)
  .brand<'PluginPermissionInstalledGenerationId'>();
export type PluginPermissionInstalledGenerationId = z.infer<
  typeof PluginPermissionInstalledGenerationIdSchema
>;

export const PluginInstallReviewPrincipalDigestSchema = LowercaseSha256DigestSchema
  .brand<'PluginInstallReviewPrincipalDigest'>();
export type PluginInstallReviewPrincipalDigest = z.infer<typeof PluginInstallReviewPrincipalDigestSchema>;

export const PluginInstallReviewPrincipalPresentationV1Schema = z.object({
  v: z.literal(1),
  packageIdentity: z.object({
    pluginId: z.string().trim().min(1).max(256),
    packageName: z.string().trim().min(1).max(512).nullable(),
  }).strict(),
  distributionIdentity: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('path'),
      development: z.boolean(),
    }).strict(),
    z.object({ kind: z.literal('archive') }).strict(),
    z.object({
      kind: z.literal('npm'),
      packageName: z.string().trim().min(1).max(512),
      registryOrigin: z.string().url().max(2_048),
      registryProfileId: z.string().trim().min(1).max(256).optional(),
    }).strict(),
  ]),
  publisherIdentity: z.union([
    z.object({ status: z.literal('unavailable') }).strict(),
    z.object({
      status: z.literal('unverified'),
      id: z.string().trim().min(1).max(512),
      displayName: z.string().trim().min(1).max(512),
    }).strict(),
  ]),
  packageSignature: z.union([
    z.object({ status: z.literal('unavailable') }).strict(),
    z.object({
      status: z.literal('verified'),
      keyId: z.string().trim().min(1).max(512),
    }).strict(),
  ]),
}).strict();
export type PluginInstallReviewPrincipalPresentationV1 = z.infer<
  typeof PluginInstallReviewPrincipalPresentationV1Schema
>;

export const PluginPermissionSubjectV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('general') }).strict(),
  z.object({
    kind: z.literal('credential_access_disclosure'),
    contribution: asProtocolZod(PluginContributionIdentityV1Schema),
    credentialSlotId: PluginCredentialAccessSlotIdSchema,
    purpose: ConnectedAccountPurposeIdSchema,
    accessDeclarationDigest: CredentialAccessDeclarationDigestSchema,
    selectedAuthorityDigest: CredentialAccessSelectedAuthorityDigestSchema,
    selectedRawAccessDigest: CredentialAccessSelectedRawAccessDigestSchema,
    installedGenerationId: PluginPermissionInstalledGenerationIdSchema,
    installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema,
  }).strict(),
]);
export type PluginPermissionSubjectV1 = z.infer<typeof PluginPermissionSubjectV1Schema>;

export const GENERAL_PLUGIN_PERMISSION_SUBJECT_V1 = Object.freeze({
  kind: 'general',
} satisfies PluginPermissionSubjectV1);

export const PluginPermissionGrantPluginIdV1Schema = z.string().trim().min(1);
export type PluginPermissionGrantPluginIdV1 = z.infer<typeof PluginPermissionGrantPluginIdV1Schema>;

export const PluginPermissionGrantTargetScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
  }).strict(),
  z.object({
    kind: z.literal('project'),
    projectId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('workspace'),
    workspaceId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginPermissionGrantTargetScopeV1 = z.infer<typeof PluginPermissionGrantTargetScopeV1Schema>;

export const PluginPermissionGrantStatusV1Schema = z.enum(['active', 'revoked']);
export type PluginPermissionGrantStatusV1 = z.infer<typeof PluginPermissionGrantStatusV1Schema>;

export const PluginPermissionGrantRequestStatusV1Schema = z.enum(['pending', 'granted', 'dismissed']);
export type PluginPermissionGrantRequestStatusV1 = z.infer<typeof PluginPermissionGrantRequestStatusV1Schema>;

export const PluginPermissionGrantActorV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('plugin'),
    pluginId: PluginPermissionGrantPluginIdV1Schema,
    sessionId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('host'),
    label: z.string().trim().min(1).optional(),
  }).strict(),
]);
export type PluginPermissionGrantActorV1 = z.infer<typeof PluginPermissionGrantActorV1Schema>;

export const PluginPermissionGrantAuthoritySourceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bundled'),
  }).strict(),
  z.object({
    kind: z.literal('machine_installation'),
    machineId: z.string().trim().min(1),
    installationId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginPermissionGrantAuthoritySourceV1 = z.infer<typeof PluginPermissionGrantAuthoritySourceV1Schema>;

const PluginPermissionGrantAuthoritySourceWithDefaultV1Schema =
  PluginPermissionGrantAuthoritySourceV1Schema.default({ kind: 'bundled' });

export const PluginPermissionGrantV1Schema = z.object({
  v: z.literal(1),
  id: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  subject: PluginPermissionSubjectV1Schema,
  authoritySource: PluginPermissionGrantAuthoritySourceWithDefaultV1Schema,
  status: PluginPermissionGrantStatusV1Schema,
  requestId: z.string().trim().min(1).optional(),
  grantedByUserId: z.string().trim().min(1),
  grantedAt: z.number().int().nonnegative(),
  revokedByUserId: z.string().trim().min(1).optional(),
  revokedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type PluginPermissionGrantV1 = z.infer<typeof PluginPermissionGrantV1Schema>;

export const PluginPermissionGrantRequestV1Schema = z.object({
  v: z.literal(1),
  id: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  subject: PluginPermissionSubjectV1Schema,
  authoritySource: PluginPermissionGrantAuthoritySourceWithDefaultV1Schema,
  requester: PluginPermissionGrantActorV1Schema,
  reason: z.string().trim().min(1),
  status: PluginPermissionGrantRequestStatusV1Schema,
  grantId: z.string().trim().min(1).optional(),
  createdByUserId: z.string().trim().min(1).optional(),
  decidedByUserId: z.string().trim().min(1).optional(),
  decidedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type PluginPermissionGrantRequestV1 = z.infer<typeof PluginPermissionGrantRequestV1Schema>;

export const PluginPermissionGrantAuditEventKindV1Schema = z.enum([
  'requested',
  'granted',
  'revoked',
  'dismissed',
]);
export type PluginPermissionGrantAuditEventKindV1 = z.infer<typeof PluginPermissionGrantAuditEventKindV1Schema>;

export const PluginPermissionGrantAuditEventV1Schema = z.object({
  v: z.literal(1),
  eventId: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  subject: PluginPermissionSubjectV1Schema,
  authoritySource: PluginPermissionGrantAuthoritySourceWithDefaultV1Schema,
  eventKind: PluginPermissionGrantAuditEventKindV1Schema,
  actor: PluginPermissionGrantActorV1Schema,
  requestId: z.string().trim().min(1).optional(),
  grantId: z.string().trim().min(1).optional(),
  previousState: z.unknown().optional(),
  nextState: z.unknown().optional(),
  reason: z.string().trim().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type PluginPermissionGrantAuditEventV1 = z.infer<typeof PluginPermissionGrantAuditEventV1Schema>;

export const PluginPermissionGrantListActionInputV1Schema = z.object({
  pluginId: PluginPermissionGrantPluginIdV1Schema.optional(),
  grantId: z.string().trim().min(1).optional(),
  capability: PluginPermissionCapabilityV1Schema.optional(),
  targetScope: PluginPermissionGrantTargetScopeV1Schema.optional(),
  subject: PluginPermissionSubjectV1Schema.optional(),
  /** Exact caller provenance for the signed plugin branch; scoped server-side. */
  caller: PluginMachineMaterializationRefV1Schema.optional(),
  includeRevoked: z.boolean().default(false),
  includeResolvedRequests: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(50),
}).strict();
export type PluginPermissionGrantListActionInputV1 = z.infer<typeof PluginPermissionGrantListActionInputV1Schema>;

export const PluginPermissionGrantRequestActionInputV1Schema = z.object({
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  subject: PluginPermissionSubjectV1Schema,
  requester: PluginPermissionGrantActorV1Schema,
  reason: z.string().trim().min(1),
  /** Exact caller provenance; server-verified against the signed publisher proof. */
  caller: PluginMachineMaterializationRefV1Schema.optional(),
}).strict();
export type PluginPermissionGrantRequestActionInputV1 = z.infer<typeof PluginPermissionGrantRequestActionInputV1Schema>;

export const PluginPermissionGrantGrantActionInputV1Schema = z.object({
  requestId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
}).strict();
export type PluginPermissionGrantGrantActionInputV1 = z.infer<typeof PluginPermissionGrantGrantActionInputV1Schema>;

export const PluginPermissionGrantRevokeActionInputV1Schema = z.object({
  grantId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
  /** Exact caller provenance for plugin self-revocation; server-verified and atomically ownership-bound. */
  caller: PluginMachineMaterializationRefV1Schema.optional(),
}).strict();
export type PluginPermissionGrantRevokeActionInputV1 = z.infer<typeof PluginPermissionGrantRevokeActionInputV1Schema>;

export const PluginPermissionGrantDismissRequestActionInputV1Schema = z.object({
  requestId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
}).strict();
export type PluginPermissionGrantDismissRequestActionInputV1 = z.infer<typeof PluginPermissionGrantDismissRequestActionInputV1Schema>;

export const PluginPermissionGrantListActionOutputV1Schema = z.object({
  grants: z.array(PluginPermissionGrantV1Schema),
  pendingRequests: z.array(PluginPermissionGrantRequestV1Schema),
}).strict();
export type PluginPermissionGrantListActionOutputV1 = z.infer<typeof PluginPermissionGrantListActionOutputV1Schema>;

export const PluginPermissionGrantRequestActionOutputV1Schema = z.object({
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict();
export type PluginPermissionGrantRequestActionOutputV1 = z.infer<typeof PluginPermissionGrantRequestActionOutputV1Schema>;

export const PluginPermissionGrantGrantActionOutputV1Schema = z.object({
  grant: PluginPermissionGrantV1Schema,
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict();
export type PluginPermissionGrantGrantActionOutputV1 = z.infer<typeof PluginPermissionGrantGrantActionOutputV1Schema>;

export const PluginPermissionGrantRevokeActionOutputV1Schema = z.object({
  grant: PluginPermissionGrantV1Schema,
}).strict();
export type PluginPermissionGrantRevokeActionOutputV1 = z.infer<typeof PluginPermissionGrantRevokeActionOutputV1Schema>;

export const PluginPermissionGrantDismissRequestActionOutputV1Schema = z.object({
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict();
export type PluginPermissionGrantDismissRequestActionOutputV1 = z.infer<typeof PluginPermissionGrantDismissRequestActionOutputV1Schema>;
