import type { ScmCapabilities } from './scm';

export function createScmCapabilities(input?: Partial<ScmCapabilities>): ScmCapabilities {
  const changeSetModel = input?.changeSetModel ?? 'working-copy';
  const supportedDiffAreas =
    input?.supportedDiffAreas ??
    (changeSetModel === 'index' ? ['included', 'pending', 'both'] : ['pending', 'both']);

  return {
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
    writeRemoteFetch: input?.writeRemoteFetch ?? false,
    writeRemotePull: input?.writeRemotePull ?? false,
    writeRemotePush: input?.writeRemotePush ?? false,
    writeRemotePublish: input?.writeRemotePublish ?? false,
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
    writeRemoteFetch: true,
    writeRemotePull: true,
    writeRemotePush: true,
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
