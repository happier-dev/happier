import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  ScmChangeSetModelSchema,
  ScmDiffAreaSchema,
} from './workingSnapshot.js';
import {
  ProviderRefreshPolicySchema,
  VcsLocalStateFreshnessSchema,
} from './freshness.js';

export const SCM_BACKEND_CAPABILITY_GROUPS = [
  'detection',
  'read',
  'changeSet',
  'commit',
  'remote',
  'branch',
  'worktree',
  'lifecycle',
  'hosting',
  'checkpoints',
  'workspaceIntegration',
  'tooling',
  'freshness',
] as const;

export const ScmBackendCapabilitySupportLevelSchema = lazyZodSchema(() => z.enum([
  'supported',
  'unsupported',
  'experimental',
]));
export type ScmBackendCapabilitySupportLevel = z.infer<typeof ScmBackendCapabilitySupportLevelSchema>;

export const ScmBackendCapabilityUnavailableReasonSchema = lazyZodSchema(() => z.enum([
  'not_implemented',
  'tool_missing',
  'repo_mode_unsupported',
  'auth_missing',
  'hosting_provider_missing',
  'unsafe_worktree_state',
  'unknown',
]));
export type ScmBackendCapabilityUnavailableReason = z.infer<typeof ScmBackendCapabilityUnavailableReasonSchema>;

export const ScmBackendCapabilityLeafSchema = lazyZodSchema(() => z.strictObject({
    support: ScmBackendCapabilitySupportLevelSchema,
    reason: z.optional(ScmBackendCapabilityUnavailableReasonSchema),
    declaredSupport: z.optional(ScmBackendCapabilitySupportLevelSchema),
  }));
export type ScmBackendCapabilityLeaf = z.infer<typeof ScmBackendCapabilityLeafSchema>;

const capabilityLeafMap = <const T extends readonly [string, ...string[]]>(keys: T) =>
  z.strictObject(Object.fromEntries(keys.map((key) => [key, z.optional(ScmBackendCapabilityLeafSchema)])) as {
    [K in T[number]]: z.ZodMiniOptional<typeof ScmBackendCapabilityLeafSchema>;
  });

export const ScmBackendDetectionCapabilitiesSchema = capabilityLeafMap([
  'repository',
  'repoIdentity',
  'ignoredPath',
  'repoMode',
  'executable',
]);

export const ScmBackendReadCapabilitiesSchema = capabilityLeafMap([
  'ignoredPaths',
  'status',
  'diffFile',
  'blame',
  'fileAtRevision',
  'diffCommit',
  'log',
  'historyEntries',
  'branches',
  'stash',
  'defaultBranch',
  'hostingProvider',
  'pullRequestStatus',
]);

export const ScmBackendChangeSetCapabilitiesSchema = z.extend(capabilityLeafMap([
  'include',
  'exclude',
  'discard',
  'stashCreate',
]), {
  model: ScmChangeSetModelSchema,
  diffAreas: z.array(ScmDiffAreaSchema).check(z.minLength(1)),
});

export const ScmBackendCommitCapabilitiesSchema = capabilityLeafMap([
  'create',
  'undoLast',
  'amend',
  'signOff',
  'expectedBase',
  'safePlan',
  'resolveOutcome',
  'pathSelection',
  'lineSelection',
  'backout',
]);

export const ScmBackendRemoteCapabilitiesSchema = capabilityLeafMap([
  'read',
  'add',
  'setUrl',
  'remove',
  'fetch',
  'pull',
  'push',
  'publish',
  'policies',
  'forceWithLease',
]);

export const ScmBackendBranchCapabilitiesSchema = capabilityLeafMap([
  'list',
  'create',
  'checkout',
  'merge',
  'rebase',
  'operationControl',
  'operationSkip',
  'conflictResolution',
]);

export const ScmBackendWorktreeCapabilitiesSchema = capabilityLeafMap([
  'create',
  'remove',
  'prune',
  'prepare',
  'retire',
  'reinstate',
]);

export const ScmBackendLifecycleCapabilitiesSchema = capabilityLeafMap([
  'init',
  'clone',
  'publish',
  'identityRediscovery',
  'removeIndexLock',
]);

export const ScmBackendHostingCapabilitiesSchema = capabilityLeafMap([
  'providerDetection',
  'repositoryPublishTargets',
  'repositoryPublish',
  'pullRequestRead',
  'pullRequestStatus',
  'pullRequestCreate',
  'pullRequestDraftCreate',
  'pullRequestReuse',
  'pullRequestCheckout',
  'pullRequestPrepareWorktree',
  'pullRequestRunStacked',
]);

export const ScmBackendCheckpointCapabilitiesSchema = capabilityLeafMap([
  'capture',
  'aliasFinalize',
  'diff',
  'cleanup',
  'backup',
  'rollbackApply',
]);

export const ScmBackendWorkspaceIntegrationCapabilitiesSchema = capabilityLeafMap([
  'inspectLocation',
  'checkoutMaterialization',
  'workspaceTransfer',
  'exportPortability',
  'portablePathClassification',
]);

export const ScmBackendToolingCapabilitiesSchema = capabilityLeafMap([
  'systemCliResolution',
  'managedCliResolution',
  'binarySafe',
]);

export const ScmBackendFreshnessCapabilitiesSchema = z.extend(capabilityLeafMap([
  'observed',
  'expiry',
]), {
  state: z.optional(VcsLocalStateFreshnessSchema),
  refreshPolicy: z.optional(ProviderRefreshPolicySchema),
});

export const ScmBackendCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
    detection: ScmBackendDetectionCapabilitiesSchema,
    read: ScmBackendReadCapabilitiesSchema,
    changeSet: ScmBackendChangeSetCapabilitiesSchema,
    commit: ScmBackendCommitCapabilitiesSchema,
    remote: ScmBackendRemoteCapabilitiesSchema,
    branch: ScmBackendBranchCapabilitiesSchema,
    worktree: ScmBackendWorktreeCapabilitiesSchema,
    lifecycle: ScmBackendLifecycleCapabilitiesSchema,
    hosting: ScmBackendHostingCapabilitiesSchema,
    checkpoints: ScmBackendCheckpointCapabilitiesSchema,
    workspaceIntegration: ScmBackendWorkspaceIntegrationCapabilitiesSchema,
    tooling: ScmBackendToolingCapabilitiesSchema,
    freshness: ScmBackendFreshnessCapabilitiesSchema,
    operationLabels: z.optional(z.strictObject({
        commit: z.optional(z.string()),
        include: z.optional(z.string()),
        exclude: z.optional(z.string()),
        backout: z.optional(z.string()),
        fetch: z.optional(z.string()),
        pull: z.optional(z.string()),
        push: z.optional(z.string()),
      })),
  }));
export type ScmBackendCapabilities = z.infer<typeof ScmBackendCapabilitiesSchema>;

export function supportedCapability(): ScmBackendCapabilityLeaf {
  return { support: 'supported' };
}

export function experimentalCapability(): ScmBackendCapabilityLeaf {
  return { support: 'experimental' };
}

export function unsupportedCapability(reason: ScmBackendCapabilityUnavailableReason = 'not_implemented'): ScmBackendCapabilityLeaf {
  return { support: 'unsupported', reason };
}
