import { describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  type ScmHostingProvider,
  type ScmPullRequestSummary,
  type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import { createGitCapabilities } from '../statusSnapshot';
import type { ScmBackendContext, ScmPullRequestBackend } from '../../../types';
import type { PrStatusCache } from '../../../hostingProviders/prStatusCache';
import { createPrStatusCache } from '../../../hostingProviders/prStatusCache';
import type { ScmHostingProviderAdapter } from '../../../hostingProviders/types';

const provider = {
  kind: 'github',
  name: 'GitHub',
  baseUrl: 'https://github.com',
  nameWithOwner: 'happier-dev/happier',
  remoteName: 'origin',
} as const;

const pullRequest: ScmPullRequestSummary = {
  provider,
  number: 51,
  title: 'Ship connected account PRs',
  url: 'https://github.com/happier-dev/happier/pull/51',
  baseBranch: 'main',
  headBranch: 'feature/connected-rest',
  state: 'open',
};

function createSnapshot(input: Readonly<{
  hostingProvider?: ScmHostingProvider;
}> = {}): ScmWorkingSnapshot {
  const hostingProvider = input.hostingProvider ?? provider;
  return {
    projectKey: 'test:/repo',
    fetchedAt: 1_000,
    repo: {
      isRepo: true,
      rootPath: '/repo',
      backendId: 'git',
      mode: '.git',
      worktrees: [],
      remotes: [{
        name: 'origin',
        fetchUrl: 'https://github.com/happier-dev/happier.git',
        pushUrl: 'https://github.com/happier-dev/happier.git',
      }],
    },
    capabilities: createGitCapabilities(),
    branch: {
      head: 'feature/connected-rest',
      upstream: 'origin/feature/connected-rest',
      ahead: 0,
      behind: 0,
      detached: false,
    },
    stashCount: 0,
    hostingProvider,
    pullRequest: null,
    hasConflicts: false,
    entries: [],
    totals: {
      includedFiles: 0,
      pendingFiles: 0,
      untrackedFiles: 0,
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 0,
      pendingRemoved: 0,
    },
  };
}

type CreateGitPullRequestBackend = (deps: Readonly<{
  readSnapshot: () => Promise<ScmWorkingSnapshot | null>;
  prStatusCache: PrStatusCache;
  githubRestAdapter: ScmHostingProviderAdapter;
  githubCliAdapter: ScmHostingProviderAdapter;
  detectGithubCliAuth: () => Promise<{ kind: 'authenticated' }>;
  gitlabCliAdapter?: ScmHostingProviderAdapter;
  detectGitlabCliAuth?: () => Promise<{ kind: 'authenticated' }>;
}>) => ScmPullRequestBackend;

const gitlabProvider = {
  kind: 'gitlab',
  name: 'GitLab',
  baseUrl: 'https://gitlab.com',
  nameWithOwner: 'happier-dev/mobile/app',
  remoteName: 'origin',
} as const satisfies ScmHostingProvider;

const gitlabMergeRequest: ScmPullRequestSummary = {
  provider: gitlabProvider,
  number: 17,
  title: 'Ship GitLab MR support',
  url: 'https://gitlab.com/happier-dev/mobile/app/-/merge_requests/17',
  baseBranch: 'main',
  headBranch: 'feature/gitlab',
  state: 'open',
};

describe('git pull request operations', () => {
  it('creates pull requests through connected account REST before local gh fallback', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let restCreateCalls = 0;
    let cliCreateCalls = 0;
    const restAdapter: ScmHostingProviderAdapter = {
      kind: 'github',
      name: 'GitHub REST',
      detectRemote: () => null,
      buildCompareUrl: () => null,
      listOpenPullRequests: async (input) => {
        expect(input.token).toBe('ghp_rest');
        return [];
      },
      createPullRequest: async (input) => {
        restCreateCalls += 1;
        expect(input.token).toBe('ghp_rest');
        expect(input.title).toBe('Ship connected account PRs');
        return pullRequest;
      },
    };
    const cliAdapter: ScmHostingProviderAdapter = {
      kind: 'github',
      name: 'GitHub CLI',
      detectRemote: () => null,
      buildCompareUrl: () => null,
      createPullRequest: async () => {
        cliCreateCalls += 1;
        throw new Error('local gh should not be used when a connected account token is available');
      },
    };
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot(),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: restAdapter,
      githubCliAdapter: cliAdapter,
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_rest',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });
    const context: ScmBackendContext = {
      cwd: '/repo',
      projectKey: 'test:/repo',
      detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    };

    await expect(backend.openOrReuse({
      context,
      request: {
        cwd: '.',
        base: 'main',
        head: 'feature/connected-rest',
        title: 'Ship connected account PRs',
        body: 'Uses connected GitHub credentials.',
      },
    })).resolves.toEqual({
      success: true,
      kind: 'opened',
      pullRequest,
      reused: false,
    });
    expect(restCreateCalls).toBe(1);
    expect(cliCreateCalls).toBe(0);
  });

  it('falls back to authenticated gh when connected-account list calls fail', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let restListCalls = 0;
    let cliListCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot(),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async () => {
          restListCalls += 1;
          throw new Error('expired token');
        },
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async () => {
          cliListCalls += 1;
          return [pullRequest];
        },
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_rest',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });
    const context: ScmBackendContext = {
      cwd: '/repo',
      projectKey: 'test:/repo',
      detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    };

    await expect(backend.list({
      context,
      request: {
        cwd: '.',
        base: 'main',
        head: 'feature/connected-rest',
      },
    })).resolves.toEqual({
      success: true,
      pullRequests: [pullRequest],
    });
    expect(restListCalls).toBe(1);
    expect(cliListCalls).toBe(1);
  });

  it('does not send github.com connected-account tokens to GitHub Enterprise hosts', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    const enterpriseProvider = {
      kind: 'github',
      name: 'GitHub',
      baseUrl: 'https://github.company.com',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'origin',
    } as const;
    let restListCalls = 0;
    let cliListCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot({ hostingProvider: enterpriseProvider }),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async () => {
          restListCalls += 1;
          throw new Error('github.com token must not be sent to enterprise host');
        },
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async (input) => {
          cliListCalls += 1;
          expect(input.provider.baseUrl).toBe('https://github.company.com');
          return [{
            ...pullRequest,
            provider: enterpriseProvider,
          }];
        },
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_github_dot_com',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });
    const context: ScmBackendContext = {
      cwd: '/repo',
      projectKey: 'test:/repo',
      detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    };

    await expect(backend.list({
      context,
      request: {
        cwd: '.',
        base: 'main',
        head: 'feature/connected-rest',
      },
    })).resolves.toMatchObject({
      success: true,
      pullRequests: [{
        provider: enterpriseProvider,
      }],
    });
    expect(restListCalls).toBe(0);
    expect(cliListCalls).toBe(1);
  });

  it('falls back to authenticated gh when connected-account get calls fail', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let restGetCalls = 0;
    let cliGetCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot(),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        getPullRequest: async () => {
          restGetCalls += 1;
          throw new Error('expired token');
        },
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        getPullRequest: async () => {
          cliGetCalls += 1;
          return pullRequest;
        },
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_rest',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });
    const context: ScmBackendContext = {
      cwd: '/repo',
      projectKey: 'test:/repo',
      detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    };

    await expect(backend.get({
      context,
      request: {
        cwd: '.',
        prReference: { number: 51 },
      },
    })).resolves.toEqual({
      success: true,
      pullRequest,
    });
    expect(restGetCalls).toBe(1);
    expect(cliGetCalls).toBe(1);
  });

  it('resolves GitHub-style URL references in pull request get operations', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let restGetCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot(),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        getPullRequest: async (input) => {
          restGetCalls += 1;
          expect(input.number).toBe(51);
          return pullRequest;
        },
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_rest',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });
    const context: ScmBackendContext = {
      cwd: '/repo',
      projectKey: 'test:/repo',
      detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    };

    await expect(backend.get({
      context,
      request: {
        cwd: '.',
        prReference: { url: 'https://github.com/happier-dev/happier/pull/51' },
      },
    })).resolves.toEqual({
      success: true,
      pullRequest,
    });
    expect(restGetCalls).toBe(1);
  });

  it('resolves head branch references in pull request get operations', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let restListCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot(),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async (input) => {
          restListCalls += 1;
          expect(input.head).toBe('feature/connected-rest');
          return [pullRequest];
        },
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_rest',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });
    const context: ScmBackendContext = {
      cwd: '/repo',
      projectKey: 'test:/repo',
      detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    };

    await expect(backend.get({
      context,
      request: {
        cwd: '.',
        prReference: { headBranch: 'feature/connected-rest' },
      },
    })).resolves.toEqual({
      success: true,
      pullRequest,
    });
    expect(restListCalls).toBe(1);
  });

  it('falls back to authenticated gh when connected-account open-or-reuse calls fail', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let restListCalls = 0;
    let restCreateCalls = 0;
    let cliListCalls = 0;
    let cliCreateCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot(),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async () => {
          restListCalls += 1;
          throw new Error('expired token');
        },
        createPullRequest: async () => {
          restCreateCalls += 1;
          throw new Error('should not create after REST list failure');
        },
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async () => {
          cliListCalls += 1;
          return [];
        },
        createPullRequest: async () => {
          cliCreateCalls += 1;
          return pullRequest;
        },
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_rest',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });
    const context: ScmBackendContext = {
      cwd: '/repo',
      projectKey: 'test:/repo',
      detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    };

    await expect(backend.openOrReuse({
      context,
      request: {
        cwd: '.',
        base: 'main',
        head: 'feature/connected-rest',
        title: 'Ship connected account PRs',
        body: 'Uses connected GitHub credentials.',
      },
    })).resolves.toEqual({
      success: true,
      kind: 'opened',
      pullRequest,
      reused: false,
    });
    expect(restListCalls).toBe(1);
    expect(restCreateCalls).toBe(0);
    expect(cliListCalls).toBe(1);
    expect(cliCreateCalls).toBe(1);
  });

  it('uses authenticated glab for GitLab merge request listing', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let gitlabListCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot({ hostingProvider: gitlabProvider }),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
      gitlabCliAdapter: {
        kind: 'gitlab',
        name: 'GitLab CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async (input) => {
          gitlabListCalls += 1;
          expect(input.provider.kind).toBe('gitlab');
          expect(input.base).toBe('main');
          expect(input.head).toBe('feature/gitlab');
          return [gitlabMergeRequest];
        },
      },
      detectGitlabCliAuth: async () => ({ kind: 'authenticated' }),
    });

    await expect(backend.list({
      context: {
        cwd: '/repo',
        projectKey: 'test:/repo',
        detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      },
      request: {
        cwd: '.',
        base: 'main',
        head: 'feature/gitlab',
      },
    })).resolves.toEqual({
      success: true,
      pullRequests: [gitlabMergeRequest],
    });
    expect(gitlabListCalls).toBe(1);
  });

  it('creates or reuses GitLab merge requests through authenticated glab before compare fallback', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    let gitlabListCalls = 0;
    let gitlabCreateCalls = 0;
    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot({ hostingProvider: gitlabProvider }),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
      gitlabCliAdapter: {
        kind: 'gitlab',
        name: 'GitLab CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async () => {
          gitlabListCalls += 1;
          return [];
        },
        createPullRequest: async () => {
          gitlabCreateCalls += 1;
          return gitlabMergeRequest;
        },
      },
      detectGitlabCliAuth: async () => ({ kind: 'authenticated' }),
    });

    await expect(backend.openOrReuse({
      context: {
        cwd: '/repo',
        projectKey: 'test:/repo',
        detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      },
      request: {
        cwd: '.',
        base: 'main',
        head: 'feature/gitlab',
        title: 'Ship GitLab MR support',
        body: 'Adds GitLab merge request support.',
      },
    })).resolves.toEqual({
      success: true,
      kind: 'opened',
      pullRequest: gitlabMergeRequest,
      reused: false,
    });
    expect(gitlabListCalls).toBe(1);
    expect(gitlabCreateCalls).toBe(1);
  });

  it('returns a command failure when authenticated glab merge request creation fails', async () => {
    const mod = await import('./pullRequestOperations') as Record<string, unknown>;
    const createBackend = mod.createGitPullRequestBackend;
    expect(createBackend).toBeTypeOf('function');
    if (typeof createBackend !== 'function') throw new Error('expected pull request backend factory');

    const backend = (createBackend as CreateGitPullRequestBackend)({
      readSnapshot: async () => createSnapshot({ hostingProvider: gitlabProvider }),
      prStatusCache: createPrStatusCache({ now: () => 1_000 }),
      githubRestAdapter: {
        kind: 'github',
        name: 'GitHub REST',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      githubCliAdapter: {
        kind: 'github',
        name: 'GitHub CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
      },
      detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
      gitlabCliAdapter: {
        kind: 'gitlab',
        name: 'GitLab CLI',
        detectRemote: () => null,
        buildCompareUrl: () => null,
        listOpenPullRequests: async () => [],
        createPullRequest: async () => {
          throw new Error('glab rejected the merge request');
        },
      },
      detectGitlabCliAuth: async () => ({ kind: 'authenticated' }),
    });

    await expect(backend.openOrReuse({
      context: {
        cwd: '/repo',
        projectKey: 'test:/repo',
        detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
      },
      request: {
        cwd: '.',
        base: 'main',
        head: 'feature/gitlab',
        title: 'Ship GitLab MR support',
        body: 'Adds GitLab merge request support.',
      },
    })).resolves.toEqual({
      success: false,
      errorCode: 'COMMAND_FAILED',
      error: 'glab rejected the merge request',
    });
  });
});
