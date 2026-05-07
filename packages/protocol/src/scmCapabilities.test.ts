import { describe, expect, it } from 'vitest';

import {
  createGitScmCapabilities,
  createSaplingScmCapabilities,
  createScmCapabilities,
} from './scmCapabilities.js';

describe('scmCapabilities', () => {
  it('creates working-copy defaults when no input is provided', () => {
    const capabilities = createScmCapabilities();
    expect(capabilities.changeSetModel).toBe('working-copy');
    expect(capabilities.supportedDiffAreas).toEqual(['pending', 'both']);
    expect(capabilities.writeCommit).toBe(false);
    expect(capabilities.writeDiscard).toBe(false);
    expect(capabilities.readBranches).toBe(false);
    expect(capabilities.writeBranchCreate).toBe(false);
    expect(capabilities.writeBranchCheckout).toBe(false);
    expect(capabilities.writeBranchMerge).toBe(false);
    expect(capabilities.writeBranchRebase).toBe(false);
    expect(capabilities.writeBranchOperationControl).toBe(false);
    expect(capabilities.writeRemoteAdd).toBe(false);
    expect(capabilities.writeRemoteSetUrl).toBe(false);
    expect(capabilities.writeRemoteRemove).toBe(false);
    expect(capabilities.writeRemotePublish).toBe(false);
    expect(capabilities.writeRepositoryInit).toBe(false);
    expect(capabilities.readHostingRepositoryPublishTargets).toBe(false);
    expect(capabilities.writeHostingRepositoryPublish).toBe(false);
    expect(capabilities.readStash).toBe(false);
    expect(capabilities.writeStash).toBe(false);
    expect(capabilities.readHostingProvider).toBe(false);
    expect(capabilities.readPullRequests).toBe(false);
    expect(capabilities.writePullRequestCreate).toBe(false);
    expect(capabilities.writePullRequestCheckout).toBe(false);
    expect(capabilities.writePullRequestPrepareWorktree).toBe(false);
    expect(capabilities.writePullRequestRunStacked).toBe(false);
    expect(capabilities.defaultBranchPushPolicy).toBe('deny');
  });

  it('creates git capability defaults', () => {
    const capabilities = createGitScmCapabilities();
    expect(capabilities.changeSetModel).toBe('index');
    expect(capabilities.supportedDiffAreas).toEqual(['included', 'pending', 'both']);
    expect(capabilities.writeInclude).toBe(true);
    expect(capabilities.writeDiscard).toBe(true);
    expect(capabilities.readBranches).toBe(true);
    expect(capabilities.writeBranchCreate).toBe(true);
    expect(capabilities.writeBranchCheckout).toBe(true);
    expect(capabilities.writeBranchMerge).toBe(true);
    expect(capabilities.writeBranchRebase).toBe(true);
    expect(capabilities.writeBranchOperationControl).toBe(true);
    expect(capabilities.writeRemoteAdd).toBe(true);
    expect(capabilities.writeRemoteSetUrl).toBe(true);
    expect(capabilities.writeRemoteRemove).toBe(true);
    expect(capabilities.writeRemotePublish).toBe(true);
    expect(capabilities.writeRepositoryInit).toBe(true);
    expect(capabilities.readHostingRepositoryPublishTargets).toBe(true);
    expect(capabilities.writeHostingRepositoryPublish).toBe(true);
    expect(capabilities.readStash).toBe(true);
    expect(capabilities.writeStash).toBe(true);
    expect(capabilities.readHostingProvider).toBe(true);
    expect(capabilities.readPullRequests).toBe(true);
    expect(capabilities.writePullRequestCreate).toBe(true);
    expect(capabilities.writePullRequestCheckout).toBe(true);
    expect(capabilities.writePullRequestPrepareWorktree).toBe(true);
    expect(capabilities.writePullRequestRunStacked).toBe(true);
    expect(capabilities.defaultBranchPushPolicy).toBe('requires-feature-branch');
  });

  it('creates sapling capability defaults', () => {
    const capabilities = createSaplingScmCapabilities();
    expect(capabilities.changeSetModel).toBe('working-copy');
    expect(capabilities.supportedDiffAreas).toEqual(['pending', 'both']);
    expect(capabilities.writeInclude).toBe(false);
    expect(capabilities.writeDiscard).toBe(true);
    expect(capabilities.readBranches).toBe(false);
    expect(capabilities.writeBranchCreate).toBe(false);
    expect(capabilities.writeBranchCheckout).toBe(false);
    expect(capabilities.writeBranchMerge).toBe(false);
    expect(capabilities.writeBranchRebase).toBe(false);
    expect(capabilities.writeBranchOperationControl).toBe(false);
    expect(capabilities.writeRemoteAdd).toBe(false);
    expect(capabilities.writeRemoteSetUrl).toBe(false);
    expect(capabilities.writeRemoteRemove).toBe(false);
    expect(capabilities.writeRemotePublish).toBe(false);
    expect(capabilities.writeRepositoryInit).toBe(false);
    expect(capabilities.readHostingRepositoryPublishTargets).toBe(false);
    expect(capabilities.writeHostingRepositoryPublish).toBe(false);
    expect(capabilities.readStash).toBe(false);
    expect(capabilities.writeStash).toBe(false);
    expect(capabilities.readHostingProvider).toBe(false);
    expect(capabilities.readPullRequests).toBe(false);
    expect(capabilities.writePullRequestCreate).toBe(false);
    expect(capabilities.writePullRequestCheckout).toBe(false);
    expect(capabilities.writePullRequestPrepareWorktree).toBe(false);
    expect(capabilities.writePullRequestRunStacked).toBe(false);
    expect(capabilities.defaultBranchPushPolicy).toBe('deny');
  });
});
