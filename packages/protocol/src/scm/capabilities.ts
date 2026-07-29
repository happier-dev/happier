import type { ScmCapabilities } from './index.js';
import type {
  ScmBackendCapabilities,
  ScmBackendCapabilityLeaf,
} from './backendCapabilities.js';

export function createScmCapabilities(input?: Partial<ScmCapabilities>): ScmCapabilities {
  const changeSetModel = input?.changeSetModel ?? 'working-copy';
  const supportedDiffAreas =
    input?.supportedDiffAreas ??
    (changeSetModel === 'index' ? ['included', 'pending', 'both'] : ['pending', 'both']);

  return {
    capabilityScope: input?.capabilityScope ?? 'local-backend',
    readStatus: input?.readStatus ?? false,
    readDiffFile: input?.readDiffFile ?? false,
    readDiffCommit: input?.readDiffCommit ?? false,
    readLog: input?.readLog ?? false,
    readBranches: input?.readBranches ?? false,
    readStash: input?.readStash ?? false,
    writeInclude: input?.writeInclude ?? false,
    writeExclude: input?.writeExclude ?? false,
    writeDiscard: input?.writeDiscard ?? false,
    writeCommit: input?.writeCommit ?? false,
    writeCommitPathSelection: input?.writeCommitPathSelection ?? false,
    writeCommitLineSelection: input?.writeCommitLineSelection ?? false,
    writeBackout: input?.writeBackout ?? false,
    writeBranchCreate: input?.writeBranchCreate ?? false,
    writeBranchCheckout: input?.writeBranchCheckout ?? false,
    writeBranchMerge: input?.writeBranchMerge ?? false,
    writeBranchRebase: input?.writeBranchRebase ?? false,
    writeBranchOperationControl: input?.writeBranchOperationControl ?? false,
    writeRemoteAdd: input?.writeRemoteAdd ?? false,
    writeRemoteSetUrl: input?.writeRemoteSetUrl ?? false,
    writeRemoteRemove: input?.writeRemoteRemove ?? false,
    writeRemoteFetch: input?.writeRemoteFetch ?? false,
    writeRemotePull: input?.writeRemotePull ?? false,
    writeRemotePush: input?.writeRemotePush ?? false,
    writeRemotePublish: input?.writeRemotePublish ?? false,
    readHostingProvider: input?.readHostingProvider ?? false,
    readPullRequestStatus: input?.readPullRequestStatus ?? false,
    writePullRequestCreate: input?.writePullRequestCreate ?? false,
    writePullRequestCheckout: input?.writePullRequestCheckout ?? false,
    writePullRequestPrepareWorktree: input?.writePullRequestPrepareWorktree ?? false,
    writePullRequestRunStacked: input?.writePullRequestRunStacked ?? false,
    defaultBranchPushPolicy: input?.defaultBranchPushPolicy ?? 'deny',
    writeRepositoryInit: input?.writeRepositoryInit ?? false,
    readHostingRepositoryPublishTargets: input?.readHostingRepositoryPublishTargets ?? false,
    writeHostingRepositoryPublish: input?.writeHostingRepositoryPublish ?? false,
    writeRepositoryRemoveIndexLock: input?.writeRepositoryRemoveIndexLock ?? false,
    writeStash: input?.writeStash ?? false,
    worktreeCreate: input?.worktreeCreate ?? false,
    changeSetModel,
    supportedDiffAreas,
    ...(input?.operationLabels ? { operationLabels: input.operationLabels } : {}),
  };
}

export function createGitScmCapabilities(input?: Partial<ScmCapabilities>): ScmCapabilities {
  return createScmCapabilities({
    readStatus: true,
    readDiffFile: true,
    readDiffCommit: true,
    readLog: true,
    readBranches: true,
    readStash: true,
    writeInclude: true,
    writeExclude: true,
    writeDiscard: true,
    writeCommit: true,
    writeCommitPathSelection: true,
    writeCommitLineSelection: true,
    writeBackout: true,
    writeBranchCreate: true,
    writeBranchCheckout: true,
    writeBranchMerge: true,
    writeBranchRebase: true,
    writeBranchOperationControl: true,
    writeRemoteAdd: true,
    writeRemoteSetUrl: true,
    writeRemoteRemove: true,
    writeRemoteFetch: true,
    writeRemotePull: true,
    writeRemotePush: true,
    writeRemotePublish: true,
    writeStash: true,
    worktreeCreate: true,
    changeSetModel: 'index',
    supportedDiffAreas: ['included', 'pending', 'both'],
    operationLabels: {
      commit: 'Commit staged',
    },
    ...input,
  });
}

function isCapabilityEnabled(capability: ScmBackendCapabilityLeaf | undefined): boolean {
  return capability?.support === 'supported' || capability?.support === 'experimental';
}

export function createScmCapabilitiesFromBackendCapabilities(
  input: ScmBackendCapabilities,
  overrides?: Partial<ScmCapabilities>,
): ScmCapabilities {
  return createScmCapabilities({
    readStatus: isCapabilityEnabled(input.read.status),
    readDiffFile: isCapabilityEnabled(input.read.diffFile),
    readDiffCommit: isCapabilityEnabled(input.read.diffCommit),
    readLog: isCapabilityEnabled(input.read.log),
    readBranches: isCapabilityEnabled(input.read.branches),
    readStash: isCapabilityEnabled(input.read.stash),
    writeInclude: isCapabilityEnabled(input.changeSet.include),
    writeExclude: isCapabilityEnabled(input.changeSet.exclude),
    writeDiscard: isCapabilityEnabled(input.changeSet.discard),
    writeCommit: isCapabilityEnabled(input.commit.create),
    writeCommitPathSelection: isCapabilityEnabled(input.commit.pathSelection),
    writeCommitLineSelection: isCapabilityEnabled(input.commit.lineSelection),
    writeBackout: isCapabilityEnabled(input.commit.backout),
    writeBranchCreate: isCapabilityEnabled(input.branch.create),
    writeBranchCheckout: isCapabilityEnabled(input.branch.checkout),
    writeBranchMerge: isCapabilityEnabled(input.branch.merge),
    writeBranchRebase: isCapabilityEnabled(input.branch.rebase),
    writeBranchOperationControl: isCapabilityEnabled(input.branch.operationControl),
    writeRemoteAdd: isCapabilityEnabled(input.remote.add),
    writeRemoteSetUrl: isCapabilityEnabled(input.remote.setUrl),
    writeRemoteRemove: isCapabilityEnabled(input.remote.remove),
    writeRemoteFetch: isCapabilityEnabled(input.remote.fetch),
    writeRemotePull: isCapabilityEnabled(input.remote.pull),
    writeRemotePush: isCapabilityEnabled(input.remote.push),
    writeRemotePublish: isCapabilityEnabled(input.remote.publish),
    readHostingProvider: isCapabilityEnabled(input.read.hostingProvider)
      || isCapabilityEnabled(input.hosting.providerDetection),
    readPullRequestStatus: isCapabilityEnabled(input.read.pullRequestStatus)
      || isCapabilityEnabled(input.hosting.pullRequestStatus),
    writePullRequestCreate: isCapabilityEnabled(input.hosting.pullRequestCreate)
      || isCapabilityEnabled(input.hosting.pullRequestReuse),
    writePullRequestCheckout: isCapabilityEnabled(input.hosting.pullRequestCheckout),
    writePullRequestPrepareWorktree: isCapabilityEnabled(input.hosting.pullRequestPrepareWorktree),
    writePullRequestRunStacked: isCapabilityEnabled(input.hosting.pullRequestRunStacked),
    writeRepositoryInit: isCapabilityEnabled(input.lifecycle.init),
    readHostingRepositoryPublishTargets: isCapabilityEnabled(input.hosting.repositoryPublishTargets),
    writeHostingRepositoryPublish: isCapabilityEnabled(input.hosting.repositoryPublish),
    writeRepositoryRemoveIndexLock: isCapabilityEnabled(input.lifecycle.removeIndexLock),
    writeStash: isCapabilityEnabled(input.read.stash),
    worktreeCreate: isCapabilityEnabled(input.worktree.create),
    changeSetModel: input.changeSet.model,
    supportedDiffAreas: input.changeSet.diffAreas,
    ...(input.operationLabels ? { operationLabels: input.operationLabels } : {}),
    ...overrides,
  });
}

export function createSaplingScmCapabilities(input?: Partial<ScmCapabilities>): ScmCapabilities {
  return createScmCapabilities({
    readStatus: true,
    readDiffFile: true,
    readDiffCommit: true,
    readLog: true,
    readBranches: false,
    readStash: false,
    writeInclude: false,
    writeExclude: false,
    writeDiscard: true,
    writeCommit: true,
    writeCommitPathSelection: true,
    writeCommitLineSelection: false,
    writeBackout: true,
    writeBranchCreate: false,
    writeBranchCheckout: false,
    writeBranchMerge: false,
    writeBranchRebase: false,
    writeBranchOperationControl: false,
    writeRemoteAdd: false,
    writeRemoteSetUrl: false,
    writeRemoteRemove: false,
    writeRemoteFetch: false,
    writeRemotePull: false,
    writeRemotePush: false,
    writeRemotePublish: false,
    writeStash: false,
    worktreeCreate: false,
    changeSetModel: 'working-copy',
    supportedDiffAreas: ['pending', 'both'],
    operationLabels: {
      commit: 'Commit changes',
    },
    ...input,
  });
}
