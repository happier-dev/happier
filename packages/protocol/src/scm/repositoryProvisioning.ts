import { z } from 'zod';

import {
  ScmOperationErrorCodeSchema,
  ScmOptionalRemoteManagementNameSchema,
  ScmRemoteInfoSchema,
  ScmRequestBaseSchema,
  ScmWorkingSnapshotSchema,
} from './index.js';
import {
  ScmHostingProviderKindSchema,
  ScmHostingProviderRefSchema,
} from './pullRequests.js';

export const ScmHostingRepositoryOwnerKindSchema = z.enum(['user', 'org']);
export type ScmHostingRepositoryOwnerKind =
  z.infer<typeof ScmHostingRepositoryOwnerKindSchema>;

export const ScmHostingRepositoryVisibilitySchema = z.enum([
  'private',
  'public',
  'internal',
]);
export type ScmHostingRepositoryVisibility =
  z.infer<typeof ScmHostingRepositoryVisibilitySchema>;

export const ScmHostingRepositoryRemoteUrlKindSchema = z.enum(['https', 'ssh']);
export type ScmHostingRepositoryRemoteUrlKind =
  z.infer<typeof ScmHostingRepositoryRemoteUrlKindSchema>;

export const ScmHostingRepositoryRemoteConflictStrategySchema = z.enum([
  'fail',
  'set-url',
]);
export type ScmHostingRepositoryRemoteConflictStrategy =
  z.infer<typeof ScmHostingRepositoryRemoteConflictStrategySchema>;

export const ScmHostingRepositoryAuthProfileKindSchema = z.enum([
  'connected_account',
  'provider_cli',
  'no_auth',
  'unknown',
]);
export type ScmHostingRepositoryAuthProfileKind =
  z.infer<typeof ScmHostingRepositoryAuthProfileKindSchema>;

export const ScmHostingRepositoryAuthStateSchema = z.enum([
  'authenticated',
  'authentication_required',
  'unsupported',
  'unknown',
]);
export type ScmHostingRepositoryAuthState =
  z.infer<typeof ScmHostingRepositoryAuthStateSchema>;

export const ScmRepositoryProvisioningRemediationKindSchema = z.enum([
  'commit_required',
  'set_url_required',
  'auth_required',
  'install_required',
  'unsupported_provider',
  'confirmation_required',
  'retry',
]);
export type ScmRepositoryProvisioningRemediationKind =
  z.infer<typeof ScmRepositoryProvisioningRemediationKindSchema>;

export const ScmRepositoryProvisioningRemediationSchema = z
  .object({
    kind: ScmRepositoryProvisioningRemediationKindSchema,
    label: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .passthrough();
export type ScmRepositoryProvisioningRemediation =
  z.infer<typeof ScmRepositoryProvisioningRemediationSchema>;

export const ScmRepositoryProvisioningFailureResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().min(1),
    errorCode: ScmOperationErrorCodeSchema.optional(),
    remediation: ScmRepositoryProvisioningRemediationSchema.optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .passthrough();
export type ScmRepositoryProvisioningFailureResponse =
  z.infer<typeof ScmRepositoryProvisioningFailureResponseSchema>;

// Repository provisioning requests inherit the shared `cwd` convention from ScmRequestBaseSchema.
export const ScmRepositoryInitRequestSchema = ScmRequestBaseSchema.extend({
  initialBranch: z.string().min(1).optional(),
}).passthrough();
export type ScmRepositoryInitRequest =
  z.infer<typeof ScmRepositoryInitRequestSchema>;

export const ScmRepositoryInitResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      alreadyInitialized: z.boolean(),
      snapshot: ScmWorkingSnapshotSchema.optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    })
    .passthrough(),
  ScmRepositoryProvisioningFailureResponseSchema,
]);
export type ScmRepositoryInitResponse =
  z.infer<typeof ScmRepositoryInitResponseSchema>;

// FD-0055 / Rule 12: stale index-lock recovery is a narrow, confirmed,
// path-validated `index.lock` removal action. The confirmation token is pinned
// to a single audit-grade literal so callers cannot smuggle ad-hoc values
// through the dispatch boundary, and `.strict()` rejects any caller-supplied
// `lockPath`/`indexLockPath`/etc. so backend resolution remains authoritative.
export const REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN = 'remove-stale-index-lock' as const;

export const ScmRepositoryRemoveIndexLockRequestSchema = ScmRequestBaseSchema.extend({
  confirmed: z.literal(true),
  confirmationToken: z.literal(REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN),
}).strict();
export type ScmRepositoryRemoveIndexLockRequest =
  z.infer<typeof ScmRepositoryRemoveIndexLockRequestSchema>;

export const ScmRepositoryRemoveIndexLockReasonSchema = z.enum([
  'removed',
  'absent',
]);
export type ScmRepositoryRemoveIndexLockReason =
  z.infer<typeof ScmRepositoryRemoveIndexLockReasonSchema>;

export const ScmRepositoryRemoveIndexLockResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      removed: z.boolean(),
      lockPath: z.string().min(1).nullable(),
      reason: ScmRepositoryRemoveIndexLockReasonSchema.optional(),
      snapshot: ScmWorkingSnapshotSchema.optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    })
    .passthrough(),
  ScmRepositoryProvisioningFailureResponseSchema,
]);
export type ScmRepositoryRemoveIndexLockResponse =
  z.infer<typeof ScmRepositoryRemoveIndexLockResponseSchema>;

export const ScmHostingRepositoryAuthSummarySchema = z
  .object({
    state: ScmHostingRepositoryAuthStateSchema,
    profileKind: ScmHostingRepositoryAuthProfileKindSchema,
    profileKey: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    remediation: ScmRepositoryProvisioningRemediationSchema.optional(),
  })
  .passthrough();
export type ScmHostingRepositoryAuthSummary =
  z.infer<typeof ScmHostingRepositoryAuthSummarySchema>;

export const ScmHostingRepositoryPublishTargetSchema = z
  .object({
    provider: ScmHostingProviderRefSchema,
    owner: z.string().min(1),
    ownerKind: ScmHostingRepositoryOwnerKindSchema,
    label: z.string().min(1),
    isDefault: z.boolean().optional(),
    supportedVisibilities: z.array(ScmHostingRepositoryVisibilitySchema).min(1),
    supportedRemoteUrlKinds: z.array(ScmHostingRepositoryRemoteUrlKindSchema).min(1),
    auth: ScmHostingRepositoryAuthSummarySchema.optional(),
    diagnostics: z.array(z.string().min(1)).optional(),
  })
  .passthrough();
export type ScmHostingRepositoryPublishTarget =
  z.infer<typeof ScmHostingRepositoryPublishTargetSchema>;

export const ScmHostingRepositorySummarySchema = z
  .object({
    provider: ScmHostingProviderRefSchema,
    nameWithOwner: z.string().min(1),
    webUrl: z.string().url(),
    cloneUrl: z.string().url().optional(),
    sshUrl: z.string().min(1).optional(),
    visibility: ScmHostingRepositoryVisibilitySchema,
    defaultBranch: z.string().min(1).nullable().optional(),
  })
  .passthrough();
export type ScmHostingRepositorySummary =
  z.infer<typeof ScmHostingRepositorySummarySchema>;

export const ScmHostingRepositoryDescribePublishTargetsRequestSchema =
  ScmRequestBaseSchema.extend({
    providerId: z.string().trim().min(1).optional(),
    providerKind: ScmHostingProviderKindSchema.optional(),
  }).passthrough();
export type ScmHostingRepositoryDescribePublishTargetsRequest =
  z.infer<typeof ScmHostingRepositoryDescribePublishTargetsRequestSchema>;

export const ScmHostingRepositoryDescribePublishTargetsResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      auth: ScmHostingRepositoryAuthSummarySchema,
      defaultRepositoryName: z.string().min(1),
      targets: z.array(ScmHostingRepositoryPublishTargetSchema),
      diagnostics: z.array(z.string().min(1)).optional(),
    })
    .passthrough(),
  ScmRepositoryProvisioningFailureResponseSchema,
]);
export type ScmHostingRepositoryDescribePublishTargetsResponse =
  z.infer<typeof ScmHostingRepositoryDescribePublishTargetsResponseSchema>;

export const ScmHostingRepositoryPublishRequestSchema = ScmRequestBaseSchema.extend({
  providerId: z.string().trim().min(1).optional(),
  providerKind: ScmHostingProviderKindSchema,
  owner: z.string().min(1),
  ownerKind: ScmHostingRepositoryOwnerKindSchema.optional(),
  repositoryName: z.string().min(1),
  visibility: ScmHostingRepositoryVisibilitySchema,
  description: z.string().optional(),
  remoteName: ScmOptionalRemoteManagementNameSchema,
  remoteUrlKind: ScmHostingRepositoryRemoteUrlKindSchema.optional(),
  remoteConflictStrategy: ScmHostingRepositoryRemoteConflictStrategySchema.optional(),
  pushCurrentBranch: z.boolean().optional(),
}).passthrough();
export type ScmHostingRepositoryPublishRequest =
  z.infer<typeof ScmHostingRepositoryPublishRequestSchema>;

export const ScmHostingRepositoryPublishResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      repository: ScmHostingRepositorySummarySchema,
      remote: ScmRemoteInfoSchema,
      pushed: z.boolean(),
      snapshot: ScmWorkingSnapshotSchema.optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    })
    .passthrough(),
  ScmRepositoryProvisioningFailureResponseSchema,
]);
export type ScmHostingRepositoryPublishResponse =
  z.infer<typeof ScmHostingRepositoryPublishResponseSchema>;
