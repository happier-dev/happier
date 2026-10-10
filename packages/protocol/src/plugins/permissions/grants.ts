import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { canonicalBoundedRecordKeySchema } from '../../common/canonicalRecordKey.js';
import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposes.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { PluginMachineMaterializationRefV1Schema } from '../availability/materializationRefV1.js';
import { PluginPermissionCapabilityV1Schema } from './capabilityV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const LowercaseSha256DigestSchema = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{64}$/u));

export const PluginCredentialAccessSlotIdSchema = canonicalBoundedRecordKeySchema(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .brand<'PluginCredentialAccessSlotId'>();
export type PluginCredentialAccessSlotId = z.infer<typeof PluginCredentialAccessSlotIdSchema>;

export const CredentialAccessDeclarationDigestSchema = lazyZodSchema(() => LowercaseSha256DigestSchema
  .brand<'CredentialAccessDeclarationDigest'>());
export type CredentialAccessDeclarationDigest = z.infer<typeof CredentialAccessDeclarationDigestSchema>;

/**
 * Domain-separated digest of the Account Settings authority selected for one
 * raw credential disclosure. It never carries secret or token material.
 */
export const CredentialAccessSelectedAuthorityDigestSchema = lazyZodSchema(() => LowercaseSha256DigestSchema
  .brand<'CredentialAccessSelectedAuthorityDigest'>());
export type CredentialAccessSelectedAuthorityDigest = z.infer<
  typeof CredentialAccessSelectedAuthorityDigestSchema
>;

/** Domain-separated digest of one exact raw realm/phase/request tuple. */
export const CredentialAccessSelectedRawAccessDigestSchema = lazyZodSchema(() => LowercaseSha256DigestSchema
  .brand<'CredentialAccessSelectedRawAccessDigest'>());
export type CredentialAccessSelectedRawAccessDigest = z.infer<
  typeof CredentialAccessSelectedRawAccessDigestSchema
>;

export const PluginInstallReviewPrincipalDigestSchema = lazyZodSchema(() => LowercaseSha256DigestSchema
  .brand<'PluginInstallReviewPrincipalDigest'>());
export type PluginInstallReviewPrincipalDigest = z.infer<typeof PluginInstallReviewPrincipalDigestSchema>;

/**
 * Exact authorization principal reviewed for one plugin installation: the
 * plugin/package identity plus the trusted distribution identity owned by the
 * current installation channel. Unverified catalog publisher labels and npm
 * registry signature keys stay installation-review evidence on the review
 * record only — a signing key authenticates the registry response rather than
 * the publisher — so neither participates in this principal, its digest, or any
 * raw-credential permission subject identity.
 */
export const PluginInstallReviewPrincipalPresentationV1Schema = lazyZodSchema(() => z.object({
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
}).strict());
export type PluginInstallReviewPrincipalPresentationV1 = z.infer<
  typeof PluginInstallReviewPrincipalPresentationV1Schema
>;

export const PluginPermissionSubjectV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('general') }).strict(),
  z.object({
    kind: z.literal('credential_access_disclosure'),
    contribution: asProtocolZod(PluginContributionIdentityV1Schema),
    credentialSlotId: PluginCredentialAccessSlotIdSchema,
    purpose: ConnectedAccountPurposeIdSchema,
    accessDeclarationDigest: CredentialAccessDeclarationDigestSchema,
    selectedAuthorityDigest: CredentialAccessSelectedAuthorityDigestSchema,
    selectedRawAccessDigest: CredentialAccessSelectedRawAccessDigestSchema,
  }).strict(),
]));
export type PluginPermissionSubjectV1 = z.infer<typeof PluginPermissionSubjectV1Schema>;

/** Compares the complete strict identity of two plugin permission subjects. */
export function pluginPermissionSubjectsEqualV1(
  leftInput: PluginPermissionSubjectV1,
  rightInput: PluginPermissionSubjectV1,
): boolean {
  const left = PluginPermissionSubjectV1Schema.parse(leftInput);
  const right = PluginPermissionSubjectV1Schema.parse(rightInput);
  if (left.kind !== right.kind) return false;
  if (left.kind === 'general' && right.kind === 'general') return true;
  if (left.kind !== 'credential_access_disclosure' || right.kind !== 'credential_access_disclosure') {
    return false;
  }
  return left.contribution.pluginId === right.contribution.pluginId
    && left.contribution.localId === right.contribution.localId
    && left.credentialSlotId === right.credentialSlotId
    && left.purpose === right.purpose
    && left.accessDeclarationDigest === right.accessDeclarationDigest
    && left.selectedAuthorityDigest === right.selectedAuthorityDigest
    && left.selectedRawAccessDigest === right.selectedRawAccessDigest;
}

export const GENERAL_PLUGIN_PERMISSION_SUBJECT_V1 = Object.freeze({
  kind: 'general',
} satisfies PluginPermissionSubjectV1);

export const PluginPermissionGrantPluginIdV1Schema = lazyZodSchema(() => z.string().trim().min(1));
export type PluginPermissionGrantPluginIdV1 = z.infer<typeof PluginPermissionGrantPluginIdV1Schema>;

export const PluginPermissionGrantTargetScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
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
]));
export type PluginPermissionGrantTargetScopeV1 = z.infer<typeof PluginPermissionGrantTargetScopeV1Schema>;

export const PluginPermissionGrantStatusV1Schema = lazyZodSchema(() => z.enum(['active', 'revoked']));
export type PluginPermissionGrantStatusV1 = z.infer<typeof PluginPermissionGrantStatusV1Schema>;

export const PluginPermissionGrantRequestStatusV1Schema = lazyZodSchema(() => z.enum(['pending', 'granted', 'dismissed']));
export type PluginPermissionGrantRequestStatusV1 = z.infer<typeof PluginPermissionGrantRequestStatusV1Schema>;

export const PluginPermissionGrantActorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
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
]));
export type PluginPermissionGrantActorV1 = z.infer<typeof PluginPermissionGrantActorV1Schema>;

export const PluginPermissionGrantAuthoritySourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bundled'),
  }).strict(),
  z.object({
    kind: z.literal('machine_installation'),
    machineId: z.string().trim().min(1),
    installationId: z.string().trim().min(1),
  }).strict(),
]));
export type PluginPermissionGrantAuthoritySourceV1 = z.infer<typeof PluginPermissionGrantAuthoritySourceV1Schema>;

const PluginPermissionGrantAuthoritySourceWithDefaultV1Schema =
  lazyZodSchema(() => PluginPermissionGrantAuthoritySourceV1Schema.default({ kind: 'bundled' }));

export const PluginPermissionGrantV1Schema = lazyZodSchema(() => z.object({
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
}).strict());
export type PluginPermissionGrantV1 = z.infer<typeof PluginPermissionGrantV1Schema>;

export const PluginPermissionGrantRequestV1Schema = lazyZodSchema(() => z.object({
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
}).strict());
export type PluginPermissionGrantRequestV1 = z.infer<typeof PluginPermissionGrantRequestV1Schema>;

export const PluginPermissionGrantAuditEventKindV1Schema = lazyZodSchema(() => z.enum([
  'requested',
  'granted',
  'revoked',
  'dismissed',
]));
export type PluginPermissionGrantAuditEventKindV1 = z.infer<typeof PluginPermissionGrantAuditEventKindV1Schema>;

export const PluginPermissionGrantAuditEventV1Schema = lazyZodSchema(() => z.object({
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
}).strict());
export type PluginPermissionGrantAuditEventV1 = z.infer<typeof PluginPermissionGrantAuditEventV1Schema>;

export const PluginPermissionGrantListActionInputV1Schema = lazyZodSchema(() => z.object({
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
}).strict());
export type PluginPermissionGrantListActionInputV1 = z.infer<typeof PluginPermissionGrantListActionInputV1Schema>;

export const PluginPermissionGrantRequestActionInputV1Schema = lazyZodSchema(() => z.object({
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  subject: PluginPermissionSubjectV1Schema,
  requester: PluginPermissionGrantActorV1Schema,
  reason: z.string().trim().min(1),
  /** Exact caller provenance; server-verified against the signed publisher proof. */
  caller: PluginMachineMaterializationRefV1Schema.optional(),
}).strict());
export type PluginPermissionGrantRequestActionInputV1 = z.infer<typeof PluginPermissionGrantRequestActionInputV1Schema>;

export const PluginPermissionGrantGrantActionInputV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
}).strict());
export type PluginPermissionGrantGrantActionInputV1 = z.infer<typeof PluginPermissionGrantGrantActionInputV1Schema>;

export const PluginPermissionGrantRevokeActionInputV1Schema = lazyZodSchema(() => z.object({
  grantId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
  /** Exact caller provenance for plugin self-revocation; server-verified and atomically ownership-bound. */
  caller: PluginMachineMaterializationRefV1Schema.optional(),
}).strict());
export type PluginPermissionGrantRevokeActionInputV1 = z.infer<typeof PluginPermissionGrantRevokeActionInputV1Schema>;

export const PluginPermissionGrantDismissRequestActionInputV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
}).strict());
export type PluginPermissionGrantDismissRequestActionInputV1 = z.infer<typeof PluginPermissionGrantDismissRequestActionInputV1Schema>;

export const PluginPermissionGrantListActionOutputV1Schema = lazyZodSchema(() => z.object({
  grants: z.array(PluginPermissionGrantV1Schema),
  pendingRequests: z.array(PluginPermissionGrantRequestV1Schema),
}).strict());
export type PluginPermissionGrantListActionOutputV1 = z.infer<typeof PluginPermissionGrantListActionOutputV1Schema>;

export const PluginPermissionGrantRequestActionOutputV1Schema = lazyZodSchema(() => z.object({
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict());
export type PluginPermissionGrantRequestActionOutputV1 = z.infer<typeof PluginPermissionGrantRequestActionOutputV1Schema>;

export const PluginPermissionGrantGrantActionOutputV1Schema = lazyZodSchema(() => z.object({
  grant: PluginPermissionGrantV1Schema,
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict());
export type PluginPermissionGrantGrantActionOutputV1 = z.infer<typeof PluginPermissionGrantGrantActionOutputV1Schema>;

export const PluginPermissionGrantRevokeActionOutputV1Schema = lazyZodSchema(() => z.object({
  grant: PluginPermissionGrantV1Schema,
}).strict());
export type PluginPermissionGrantRevokeActionOutputV1 = z.infer<typeof PluginPermissionGrantRevokeActionOutputV1Schema>;

export const PluginPermissionGrantDismissRequestActionOutputV1Schema = lazyZodSchema(() => z.object({
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict());
export type PluginPermissionGrantDismissRequestActionOutputV1 = z.infer<typeof PluginPermissionGrantDismissRequestActionOutputV1Schema>;
