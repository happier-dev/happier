import { z } from 'zod';

import {
  ScmChangeSetModelSchema,
  ScmDiffAreaSchema,
} from './index.js';
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

export const ScmBackendCapabilitySupportLevelSchema = z.enum([
  'supported',
  'unsupported',
  'experimental',
]);
export type ScmBackendCapabilitySupportLevel = z.infer<typeof ScmBackendCapabilitySupportLevelSchema>;

export const ScmBackendCapabilityUnavailableReasonSchema = z.enum([
  'not_implemented',
  'tool_missing',
  'repo_mode_unsupported',
  'auth_missing',
  'hosting_provider_missing',
  'unsafe_worktree_state',
  'unknown',
]);
export type ScmBackendCapabilityUnavailableReason = z.infer<typeof ScmBackendCapabilityUnavailableReasonSchema>;

export const ScmBackendCapabilityLeafSchema = z
  .object({
    support: ScmBackendCapabilitySupportLevelSchema,
    reason: ScmBackendCapabilityUnavailableReasonSchema.optional(),
    declaredSupport: ScmBackendCapabilitySupportLevelSchema.optional(),
  })
  .strict();
export type ScmBackendCapabilityLeaf = z.infer<typeof ScmBackendCapabilityLeafSchema>;

const capabilityLeafMap = <const T extends readonly [string, ...string[]]>(keys: T) =>
  z.object(Object.fromEntries(keys.map((key) => [key, ScmBackendCapabilityLeafSchema.optional()])) as {
    [K in T[number]]: z.ZodOptional<typeof ScmBackendCapabilityLeafSchema>;
  }).strict();

export const ScmBackendDetectionCapabilitiesSchema = capabilityLeafMap([
  'repository',
  'repoIdentity',
  'ignoredPath',
  'repoMode',
  'executable',
]);

export const ScmBackendReadCapabilitiesSchema = capabilityLeafMap([
  'status',
  'diffFile',
  'diffCommit',
  'log',
  'branches',
  'stash',
  'defaultBranch',
  'hostingProvider',
  'pullRequestStatus',
]);

export const ScmBackendChangeSetCapabilitiesSchema = capabilityLeafMap([
  'include',
  'exclude',
  'discard',
]).extend({
  model: ScmChangeSetModelSchema,
  diffAreas: z.array(ScmDiffAreaSchema).min(1),
});

export const ScmBackendCommitCapabilitiesSchema = capabilityLeafMap([
  'create',
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
]);

export const ScmBackendBranchCapabilitiesSchema = capabilityLeafMap([
  'list',
  'create',
  'checkout',
  'merge',
  'rebase',
  'operationControl',
]);

export const ScmBackendWorktreeCapabilitiesSchema = capabilityLeafMap([
  'create',
  'remove',
  'prune',
  'prepare',
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

export const ScmBackendFreshnessCapabilitiesSchema = capabilityLeafMap([
  'observed',
  'expiry',
]).extend({
  state: VcsLocalStateFreshnessSchema.optional(),
  refreshPolicy: ProviderRefreshPolicySchema.optional(),
});

export const ScmBackendCapabilitiesSchema = z
  .object({
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
    operationLabels: z
      .object({
        commit: z.string().optional(),
        include: z.string().optional(),
        exclude: z.string().optional(),
        backout: z.string().optional(),
        fetch: z.string().optional(),
        pull: z.string().optional(),
        push: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
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
