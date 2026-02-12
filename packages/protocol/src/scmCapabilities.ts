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
    writeInclude: input?.writeInclude ?? false,
    writeExclude: input?.writeExclude ?? false,
    writeCommit: input?.writeCommit ?? false,
    writeCommitPathSelection: input?.writeCommitPathSelection ?? false,
    writeCommitLineSelection: input?.writeCommitLineSelection ?? false,
    writeBackout: input?.writeBackout ?? false,
    writeRemoteFetch: input?.writeRemoteFetch ?? false,
    writeRemotePull: input?.writeRemotePull ?? false,
    writeRemotePush: input?.writeRemotePush ?? false,
    workspaceWorktreeCreate: input?.workspaceWorktreeCreate ?? false,
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
    writeInclude: true,
    writeExclude: true,
    writeCommit: true,
    writeCommitPathSelection: true,
    writeCommitLineSelection: true,
    writeBackout: true,
    writeRemoteFetch: true,
    writeRemotePull: true,
    writeRemotePush: true,
    workspaceWorktreeCreate: true,
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
    writeInclude: false,
    writeExclude: false,
    writeCommit: true,
    writeCommitPathSelection: true,
    writeCommitLineSelection: false,
    writeBackout: true,
    writeRemoteFetch: true,
    writeRemotePull: true,
    writeRemotePush: true,
    workspaceWorktreeCreate: false,
    changeSetModel: 'working-copy',
    supportedDiffAreas: ['pending', 'both'],
    operationLabels: {
      commit: 'Commit changes',
    },
    ...input,
  });
}
