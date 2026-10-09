import type { ScmCapabilities } from './index.js';
import type { ScmCommitCreateRequest } from './index.js';
import type { ScmOperationOutcome } from './operationOutcome.js';
import type {
  ScmBackendCapabilities,
  ScmBackendCapabilityLeaf,
} from './backendCapabilities.js';

export function admitScmCommitPolicy(
  request: Pick<ScmCommitCreateRequest, 'mode' | 'signOff' | 'expectedHeadOid' | 'expectedRef' | 'expectedCandidateTreeOid' | 'preparedTreeOid' | 'acceptedHookTreeOid' | 'expectedIndexTreeOid'>,
  capabilities?: Partial<Pick<ScmCapabilities, 'writeCommitAmend' | 'writeCommitSignOff' | 'writeCommitExpectedBase' | 'writeCommitSafePlan'>>,
): Readonly<{ success: true }> | Readonly<{ success: false; errorCode: 'FEATURE_UNSUPPORTED'; error: string; outcome: ScmOperationOutcome }> {
  if ((request.mode === 'amend' && capabilities?.writeCommitAmend !== true)
    || (request.signOff === true && capabilities?.writeCommitSignOff !== true)
    || ((request.expectedHeadOid !== undefined || request.expectedRef !== undefined) && capabilities?.writeCommitExpectedBase !== true)
    || ((request.expectedCandidateTreeOid !== undefined || request.preparedTreeOid !== undefined || request.acceptedHookTreeOid !== undefined || request.expectedIndexTreeOid !== undefined) && capabilities?.writeCommitSafePlan !== true)) {
    const error = 'The selected SCM backend does not support the requested commit option';
    return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error,
      outcome: { v: 1, kind: 'failed', errorCode: 'FEATURE_UNSUPPORTED', nextActions: [], message: error } };
  }
  return { success: true };
}

/** Undo is a separate mutation; ordinary commit support cannot authorize it. */
export function admitScmCommitUndoLast(
  capabilities?: Partial<Pick<ScmCapabilities, 'writeCommitUndoLast'>>,
): Readonly<{ success: true }> | Readonly<{ success: false; errorCode: 'FEATURE_UNSUPPORTED'; error: string; outcome: ScmOperationOutcome }> {
  if (capabilities?.writeCommitUndoLast === true) return { success: true };
  const error = 'The selected SCM backend does not support undoing the last commit';
  return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error,
    outcome: { v: 1, kind: 'failed', errorCode: 'FEATURE_UNSUPPORTED', nextActions: [], message: error } };
}

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
    readHistoryEntries: input?.readHistoryEntries ?? false,
    readBranches: input?.readBranches ?? false,
    readStash: input?.readStash ?? false,
    writeInclude: input?.writeInclude ?? false,
    writeExclude: input?.writeExclude ?? false,
    writeDiscard: input?.writeDiscard ?? false,
    writeCommit: input?.writeCommit ?? false,
    writeCommitUndoLast: input?.writeCommitUndoLast ?? false,
    writeCommitAmend: input?.writeCommitAmend ?? false,
    writeCommitSignOff: input?.writeCommitSignOff ?? false,
    writeCommitExpectedBase: input?.writeCommitExpectedBase ?? false,
    writeCommitSafePlan: input?.writeCommitSafePlan ?? false,
    readCommitResolveOutcome: input?.readCommitResolveOutcome ?? false,
    writeCommitPathSelection: input?.writeCommitPathSelection ?? false,
    writeCommitLineSelection: input?.writeCommitLineSelection ?? false,
    writeBackout: input?.writeBackout ?? false,
    writeBranchCreate: input?.writeBranchCreate ?? false,
    writeBranchCheckout: input?.writeBranchCheckout ?? false,
    writeBranchMerge: input?.writeBranchMerge ?? false,
    writeBranchRebase: input?.writeBranchRebase ?? false,
    writeBranchOperationControl: input?.writeBranchOperationControl ?? false,
    writeBranchOperationSkip: input?.writeBranchOperationSkip ?? false,
    writeConflictResolution: input?.writeConflictResolution ?? false,
    writeRemoteAdd: input?.writeRemoteAdd ?? false,
    writeRemoteSetUrl: input?.writeRemoteSetUrl ?? false,
    writeRemoteRemove: input?.writeRemoteRemove ?? false,
    writeRemoteFetch: input?.writeRemoteFetch ?? false,
    writeRemotePull: input?.writeRemotePull ?? false,
    writeRemotePush: input?.writeRemotePush ?? false,
    writeRemotePublish: input?.writeRemotePublish ?? false,
    writeRemotePolicies: input?.writeRemotePolicies ?? false,
    writeRemoteForceWithLease: input?.writeRemoteForceWithLease ?? false,
    readHostingProvider: input?.readHostingProvider ?? false,
    readPullRequestStatus: input?.readPullRequestStatus ?? false,
    writePullRequestCreate: input?.writePullRequestCreate ?? false,
    writePullRequestDraftCreate: input?.writePullRequestDraftCreate ?? false,
    writePullRequestCheckout: input?.writePullRequestCheckout ?? false,
    writePullRequestPrepareWorktree: input?.writePullRequestPrepareWorktree ?? false,
    writePullRequestRunStacked: input?.writePullRequestRunStacked ?? false,
    defaultBranchPushPolicy: input?.defaultBranchPushPolicy ?? 'deny',
    writeRepositoryInit: input?.writeRepositoryInit ?? false,
    readHostingRepositoryPublishTargets: input?.readHostingRepositoryPublishTargets ?? false,
    writeHostingRepositoryPublish: input?.writeHostingRepositoryPublish ?? false,
    writeRepositoryRemoveIndexLock: input?.writeRepositoryRemoveIndexLock ?? false,
    writeStash: input?.writeStash ?? false,
    writeStashCreate: input?.writeStashCreate ?? false,
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
    writeStashCreate: true,
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
    readHistoryEntries: isCapabilityEnabled(input.read.historyEntries),
    readBranches: isCapabilityEnabled(input.read.branches),
    readStash: isCapabilityEnabled(input.read.stash),
    writeInclude: isCapabilityEnabled(input.changeSet.include),
    writeExclude: isCapabilityEnabled(input.changeSet.exclude),
    writeDiscard: isCapabilityEnabled(input.changeSet.discard),
    writeCommit: isCapabilityEnabled(input.commit.create),
    writeCommitUndoLast: isCapabilityEnabled(input.commit.undoLast),
    writeCommitAmend: isCapabilityEnabled(input.commit.amend),
    writeCommitSignOff: isCapabilityEnabled(input.commit.signOff),
    writeCommitExpectedBase: isCapabilityEnabled(input.commit.expectedBase),
    writeCommitSafePlan: isCapabilityEnabled(input.commit.safePlan),
    readCommitResolveOutcome: isCapabilityEnabled(input.commit.resolveOutcome),
    writeCommitPathSelection: isCapabilityEnabled(input.commit.pathSelection),
    writeCommitLineSelection: isCapabilityEnabled(input.commit.lineSelection),
    writeBackout: isCapabilityEnabled(input.commit.backout),
    writeBranchCreate: isCapabilityEnabled(input.branch.create),
    writeBranchCheckout: isCapabilityEnabled(input.branch.checkout),
    writeBranchMerge: isCapabilityEnabled(input.branch.merge),
    writeBranchRebase: isCapabilityEnabled(input.branch.rebase),
    writeBranchOperationControl: isCapabilityEnabled(input.branch.operationControl),
    writeBranchOperationSkip: isCapabilityEnabled(input.branch.operationSkip),
    writeConflictResolution: isCapabilityEnabled(input.branch.conflictResolution),
    writeRemoteAdd: isCapabilityEnabled(input.remote.add),
    writeRemoteSetUrl: isCapabilityEnabled(input.remote.setUrl),
    writeRemoteRemove: isCapabilityEnabled(input.remote.remove),
    writeRemoteFetch: isCapabilityEnabled(input.remote.fetch),
    writeRemotePull: isCapabilityEnabled(input.remote.pull),
    writeRemotePush: isCapabilityEnabled(input.remote.push),
    writeRemotePublish: isCapabilityEnabled(input.remote.publish),
    writeRemotePolicies: isCapabilityEnabled(input.remote.policies),
    writeRemoteForceWithLease: isCapabilityEnabled(input.remote.forceWithLease),
    readHostingProvider: isCapabilityEnabled(input.read.hostingProvider)
      || isCapabilityEnabled(input.hosting.providerDetection),
    readPullRequestStatus: isCapabilityEnabled(input.read.pullRequestStatus)
      || isCapabilityEnabled(input.hosting.pullRequestStatus),
    writePullRequestCreate: isCapabilityEnabled(input.hosting.pullRequestCreate)
      || isCapabilityEnabled(input.hosting.pullRequestReuse),
    writePullRequestDraftCreate: isCapabilityEnabled(input.hosting.pullRequestDraftCreate),
    writePullRequestCheckout: isCapabilityEnabled(input.hosting.pullRequestCheckout),
    writePullRequestPrepareWorktree: isCapabilityEnabled(input.hosting.pullRequestPrepareWorktree),
    writePullRequestRunStacked: isCapabilityEnabled(input.hosting.pullRequestRunStacked),
    writeRepositoryInit: isCapabilityEnabled(input.lifecycle.init),
    readHostingRepositoryPublishTargets: isCapabilityEnabled(input.hosting.repositoryPublishTargets),
    writeHostingRepositoryPublish: isCapabilityEnabled(input.hosting.repositoryPublish),
    writeRepositoryRemoveIndexLock: isCapabilityEnabled(input.lifecycle.removeIndexLock),
    writeStash: isCapabilityEnabled(input.read.stash),
    writeStashCreate: isCapabilityEnabled(input.changeSet.stashCreate),
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
