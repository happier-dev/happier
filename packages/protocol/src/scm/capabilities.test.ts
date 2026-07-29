import { describe, expect, it } from 'vitest';

import {
  createGitScmCapabilities,
  createSaplingScmCapabilities,
  createScmCapabilities,
} from './capabilities.js';

describe('scmCapabilities', () => {
  it('creates working-copy defaults when no input is provided', () => {
    const capabilities = createScmCapabilities();
    expect(capabilities.capabilityScope).toBe('local-backend');
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
    expect(capabilities.writeRemoteFetch).toBe(false);
    expect(capabilities.writeRemotePull).toBe(false);
    expect(capabilities.writeRemotePush).toBe(false);
    expect(capabilities.writeRemotePublish).toBe(false);
    expect(capabilities.readHostingProvider).toBe(false);
    expect(capabilities.readPullRequestStatus).toBe(false);
    expect(capabilities.writePullRequestCreate).toBe(false);
    expect(capabilities.writePullRequestCheckout).toBe(false);
    expect(capabilities.writePullRequestPrepareWorktree).toBe(false);
    expect(capabilities.writePullRequestRunStacked).toBe(false);
    expect(capabilities.defaultBranchPushPolicy).toBe('deny');
    expect(capabilities.writeRepositoryInit).toBe(false);
    expect(capabilities.readHostingRepositoryPublishTargets).toBe(false);
    expect(capabilities.writeHostingRepositoryPublish).toBe(false);
    expect(capabilities.writeRepositoryRemoveIndexLock).toBe(false);
    expect(capabilities.readStash).toBe(false);
    expect(capabilities.writeStash).toBe(false);
  });

  it('creates git capability defaults', () => {
    const capabilities = createGitScmCapabilities();
    expect(capabilities.capabilityScope).toBe('local-backend');
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
    expect(capabilities.readHostingProvider).toBe(false);
    expect(capabilities.readPullRequestStatus).toBe(false);
    expect(capabilities.writePullRequestCreate).toBe(false);
    expect(capabilities.writePullRequestCheckout).toBe(false);
    expect(capabilities.writePullRequestPrepareWorktree).toBe(false);
    expect(capabilities.writePullRequestRunStacked).toBe(false);
    expect(capabilities.defaultBranchPushPolicy).toBe('deny');
    expect(capabilities.writeRepositoryInit).toBe(false);
    expect(capabilities.readHostingRepositoryPublishTargets).toBe(false);
    expect(capabilities.writeHostingRepositoryPublish).toBe(false);
    expect(capabilities.writeRepositoryRemoveIndexLock).toBe(false);
    expect(capabilities.readStash).toBe(true);
    expect(capabilities.writeStash).toBe(true);
  });

  it('creates sapling capability defaults', () => {
    const capabilities = createSaplingScmCapabilities();
    expect(capabilities.capabilityScope).toBe('local-backend');
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
    expect(capabilities.writeRemoteFetch).toBe(false);
    expect(capabilities.writeRemotePull).toBe(false);
    expect(capabilities.writeRemotePush).toBe(false);
    expect(capabilities.writeRemotePublish).toBe(false);
    expect(capabilities.readHostingProvider).toBe(false);
    expect(capabilities.readPullRequestStatus).toBe(false);
    expect(capabilities.writePullRequestCreate).toBe(false);
    expect(capabilities.writePullRequestCheckout).toBe(false);
    expect(capabilities.writePullRequestPrepareWorktree).toBe(false);
    expect(capabilities.writePullRequestRunStacked).toBe(false);
    expect(capabilities.defaultBranchPushPolicy).toBe('deny');
    expect(capabilities.writeRepositoryInit).toBe(false);
    expect(capabilities.readHostingRepositoryPublishTargets).toBe(false);
    expect(capabilities.writeHostingRepositoryPublish).toBe(false);
    expect(capabilities.writeRepositoryRemoveIndexLock).toBe(false);
    expect(capabilities.readStash).toBe(false);
    expect(capabilities.writeStash).toBe(false);
  });

  it('preserves explicit local backend capability scope overrides', () => {
    expect(createScmCapabilities({ capabilityScope: 'local-backend' }).capabilityScope)
      .toBe('local-backend');
  });

  it('projects grouped Git backend capabilities to the existing flat capability contract', async () => {
    const module = await import('./capabilities.js');
    expect(module.createScmCapabilitiesFromBackendCapabilities).toEqual(expect.any(Function));
    if (!module.createScmCapabilitiesFromBackendCapabilities) return;

    const capabilityModule = await import('./backendCapabilities.js').catch(() => null);
    expect(capabilityModule).not.toBeNull();
    if (!capabilityModule) return;

    const grouped = capabilityModule.ScmBackendCapabilitiesSchema.parse({
      detection: {},
      read: {
        status: { support: 'supported' },
        diffFile: { support: 'supported' },
        diffCommit: { support: 'supported' },
        log: { support: 'supported' },
        branches: { support: 'supported' },
        stash: { support: 'supported' },
        hostingProvider: { support: 'supported' },
        pullRequestStatus: { support: 'supported' },
      },
      changeSet: {
        model: 'index',
        diffAreas: ['included', 'pending', 'both'],
        include: { support: 'supported' },
        exclude: { support: 'supported' },
        discard: { support: 'supported' },
      },
      commit: {
        create: { support: 'supported' },
        pathSelection: { support: 'supported' },
        lineSelection: { support: 'supported' },
        backout: { support: 'supported' },
      },
      remote: {
        add: { support: 'supported' },
        setUrl: { support: 'supported' },
        remove: { support: 'supported' },
        fetch: { support: 'supported' },
        pull: { support: 'supported' },
        push: { support: 'supported' },
        publish: { support: 'supported' },
      },
      branch: {
        create: { support: 'supported' },
        checkout: { support: 'supported' },
        merge: { support: 'supported' },
        rebase: { support: 'supported' },
        operationControl: { support: 'supported' },
      },
      worktree: {
        create: { support: 'supported' },
      },
      lifecycle: {
        init: { support: 'supported' },
        removeIndexLock: { support: 'supported' },
      },
      hosting: {
        repositoryPublishTargets: { support: 'supported' },
        repositoryPublish: { support: 'supported' },
        pullRequestCreate: { support: 'supported' },
        pullRequestCheckout: { support: 'supported' },
        pullRequestPrepareWorktree: { support: 'supported' },
        pullRequestRunStacked: { support: 'supported' },
      },
      checkpoints: {},
      workspaceIntegration: {},
      tooling: {},
      freshness: {},
      operationLabels: {
        commit: 'Commit staged',
      },
    });

    expect(module.createScmCapabilitiesFromBackendCapabilities(grouped)).toEqual(createGitScmCapabilities({
      readHostingProvider: true,
      readPullRequestStatus: true,
      writePullRequestCreate: true,
      writePullRequestCheckout: true,
      writePullRequestPrepareWorktree: true,
      writePullRequestRunStacked: true,
      writeRepositoryInit: true,
      readHostingRepositoryPublishTargets: true,
      writeHostingRepositoryPublish: true,
      writeRepositoryRemoveIndexLock: true,
    }));
  });

  it('keeps unsupported grouped capability leaves disabled in the flat projection', async () => {
    const module = await import('./capabilities.js');
    expect(module.createScmCapabilitiesFromBackendCapabilities).toEqual(expect.any(Function));
    if (!module.createScmCapabilitiesFromBackendCapabilities) return;

    const capabilityModule = await import('./backendCapabilities.js').catch(() => null);
    expect(capabilityModule).not.toBeNull();
    if (!capabilityModule) return;

    const grouped = capabilityModule.ScmBackendCapabilitiesSchema.parse({
      detection: {},
      read: {
        status: { support: 'supported' },
        diffFile: { support: 'supported' },
        branches: { support: 'unsupported', reason: 'not_implemented' },
      },
      changeSet: {
        model: 'working-copy',
        diffAreas: ['pending', 'both'],
        include: { support: 'unsupported', reason: 'not_implemented' },
        discard: { support: 'supported' },
      },
      commit: {
        create: { support: 'supported' },
        lineSelection: { support: 'unsupported', reason: 'not_implemented' },
      },
      remote: {
        push: { support: 'supported' },
      },
      branch: {},
      worktree: {},
      lifecycle: {},
      hosting: {},
      checkpoints: {},
      workspaceIntegration: {},
      tooling: {},
      freshness: {},
    });

    expect(module.createScmCapabilitiesFromBackendCapabilities(grouped)).toEqual(createScmCapabilities({
      readStatus: true,
      readDiffFile: true,
      writeDiscard: true,
      writeCommit: true,
      writeRemotePush: true,
      changeSetModel: 'working-copy',
      supportedDiffAreas: ['pending', 'both'],
    }));
  });
});
