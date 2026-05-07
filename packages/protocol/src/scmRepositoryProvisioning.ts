import { z } from 'zod';

import {
  ScmOperationErrorCodeSchema,
  ScmRemoteInfoSchema,
  ScmRequestBaseSchema,
  ScmWorkingSnapshotSchema,
} from './scm.js';
import {
  ScmHostingProviderKindSchema,
  ScmHostingProviderSchema,
} from './scmPullRequests.js';

const ScmRepositoryProvisioningErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
  errorCode: ScmOperationErrorCodeSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});

export const ScmRepositoryInitRequestSchema = ScmRequestBaseSchema.extend({
  initialBranch: z.string().min(1).max(255).optional(),
});
export type ScmRepositoryInitRequest = z.infer<typeof ScmRepositoryInitRequestSchema>;

export const ScmRepositoryInitResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    alreadyInitialized: z.boolean(),
    snapshot: ScmWorkingSnapshotSchema.optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }),
  ScmRepositoryProvisioningErrorResponseSchema,
]);
export type ScmRepositoryInitResponse = z.infer<typeof ScmRepositoryInitResponseSchema>;

export const ScmRepositoryRemoveIndexLockRequestSchema = ScmRequestBaseSchema;
export type ScmRepositoryRemoveIndexLockRequest =
  z.infer<typeof ScmRepositoryRemoveIndexLockRequestSchema>;

export const ScmRepositoryRemoveIndexLockResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    removed: z.boolean(),
    lockPath: z.string().min(1).nullable(),
    snapshot: ScmWorkingSnapshotSchema.optional(),
  }),
  ScmRepositoryProvisioningErrorResponseSchema,
]);
export type ScmRepositoryRemoveIndexLockResponse =
  z.infer<typeof ScmRepositoryRemoveIndexLockResponseSchema>;

export const ScmHostingRepositoryVisibilitySchema = z.enum([
  'private',
  'public',
  'internal',
]);
export type ScmHostingRepositoryVisibility = z.infer<typeof ScmHostingRepositoryVisibilitySchema>;

export const ScmHostingRepositoryOwnerKindSchema = z.enum([
  'user',
  'org',
]);
export type ScmHostingRepositoryOwnerKind = z.infer<typeof ScmHostingRepositoryOwnerKindSchema>;

export const ScmHostingRepositoryRemoteUrlKindSchema = z.enum([
  'https',
  'ssh',
]);
export type ScmHostingRepositoryRemoteUrlKind =
  z.infer<typeof ScmHostingRepositoryRemoteUrlKindSchema>;

export const ScmHostingRepositoryRemoteConflictStrategySchema = z.enum([
  'fail',
  'set-url',
]);
export type ScmHostingRepositoryRemoteConflictStrategy =
  z.infer<typeof ScmHostingRepositoryRemoteConflictStrategySchema>;

export const ScmHostingRepositoryPublishTargetSchema = z.object({
  providerKind: ScmHostingProviderKindSchema,
  owner: z.string().min(1),
  ownerKind: ScmHostingRepositoryOwnerKindSchema,
  label: z.string().min(1).optional(),
  default: z.boolean().optional(),
  supportedVisibilities: z.array(ScmHostingRepositoryVisibilitySchema).min(1),
});
export type ScmHostingRepositoryPublishTarget =
  z.infer<typeof ScmHostingRepositoryPublishTargetSchema>;

export const ScmHostingRepositorySummarySchema = z.object({
  provider: ScmHostingProviderSchema,
  nameWithOwner: z.string().min(1),
  url: z.string().url(),
  cloneUrl: z.string().min(1).optional(),
  sshUrl: z.string().min(1).optional(),
  visibility: ScmHostingRepositoryVisibilitySchema,
  defaultBranch: z.string().min(1).nullable().optional(),
});
export type ScmHostingRepositorySummary = z.infer<typeof ScmHostingRepositorySummarySchema>;

export const ScmHostingRepositoryAuthSummarySchema = z.object({
  kind: z.enum(['connected-account', 'gh-cli', 'none']),
  authenticated: z.boolean(),
  installableKey: z.string().min(1).optional(),
});
export type ScmHostingRepositoryAuthSummary =
  z.infer<typeof ScmHostingRepositoryAuthSummarySchema>;

export const ScmHostingRepositoryDescribePublishTargetsRequestSchema =
  ScmRequestBaseSchema.extend({
    providerKind: ScmHostingProviderKindSchema.optional(),
  });
export type ScmHostingRepositoryDescribePublishTargetsRequest =
  z.infer<typeof ScmHostingRepositoryDescribePublishTargetsRequestSchema>;

export const ScmHostingRepositoryDescribePublishTargetsResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    auth: ScmHostingRepositoryAuthSummarySchema,
    defaultRepositoryName: z.string().min(1).optional(),
    targets: z.array(ScmHostingRepositoryPublishTargetSchema),
  }),
  ScmRepositoryProvisioningErrorResponseSchema,
]);
export type ScmHostingRepositoryDescribePublishTargetsResponse =
  z.infer<typeof ScmHostingRepositoryDescribePublishTargetsResponseSchema>;

export const ScmHostingRepositoryPublishRequestSchema = ScmRequestBaseSchema.extend({
  providerKind: ScmHostingProviderKindSchema,
  owner: z.string().min(1),
  ownerKind: ScmHostingRepositoryOwnerKindSchema,
  repositoryName: z.string().min(1).max(100),
  visibility: ScmHostingRepositoryVisibilitySchema,
  description: z.string().max(2048).optional(),
  remoteName: z.string().min(1).optional(),
  remoteUrlKind: ScmHostingRepositoryRemoteUrlKindSchema.optional(),
  remoteConflictStrategy: ScmHostingRepositoryRemoteConflictStrategySchema.optional(),
  pushCurrentBranch: z.boolean().optional(),
});
export type ScmHostingRepositoryPublishRequest =
  z.infer<typeof ScmHostingRepositoryPublishRequestSchema>;

export const ScmHostingRepositoryPublishResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    repository: ScmHostingRepositorySummarySchema,
    remote: ScmRemoteInfoSchema,
    pushed: z.boolean(),
    snapshot: ScmWorkingSnapshotSchema.optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }),
  ScmRepositoryProvisioningErrorResponseSchema,
]);
export type ScmHostingRepositoryPublishResponse =
  z.infer<typeof ScmHostingRepositoryPublishResponseSchema>;
