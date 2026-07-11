import type {
  ScmHostingProviderRef,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it } from 'vitest';

const githubProvider: ScmHostingProviderRef = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  nameWithOwner: 'happier-dev/happier',
  urlSafety: { allowedSchemes: ['https:'] },
};

const enterpriseProvider: ScmHostingProviderRef = {
  ...githubProvider,
  baseUrl: 'https://ghe.internal.test',
};

const pullRequest: ScmPullRequestSummary = {
  provider: githubProvider,
  number: 3,
  title: 'Adapter chain',
  url: 'https://github.com/happier-dev/happier/pull/3',
  baseBranch: 'main',
  headBranch: 'feature/chain',
  state: 'open',
};

describe('GitHub pull request auth chain', () => {
  it('uses github.com REST before gh CLI', async () => {
    const mod = await import('./authChain.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: string[] = [];
    const adapter = mod.createGithubPullRequestAdapter({
      restAdapter: {
        listPullRequests: async () => {
          calls.push('rest');
          return [pullRequest];
        },
      },
      cliAdapter: {
        listPullRequests: async () => {
          calls.push('cli');
          return [];
        },
      },
    });

    await expect(adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/chain',
    })).resolves.toEqual([pullRequest]);
    expect(calls).toEqual(['rest']);
  });

  it('falls through to authenticated gh when REST auth is stale', async () => {
    const mod = await import('./authChain.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const error = new Error('GitHub REST authentication failed');
    Object.assign(error, { errorCode: 'REMOTE_AUTH_REQUIRED' });
    const calls: string[] = [];
    const adapter = mod.createGithubPullRequestAdapter({
      restAdapter: {
        listPullRequests: async () => {
          calls.push('rest');
          throw error;
        },
      },
      cliAdapter: {
        listPullRequests: async () => {
          calls.push('cli');
          return [pullRequest];
        },
      },
    });

    await expect(adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/chain',
    })).resolves.toEqual([pullRequest]);
    expect(calls).toEqual(['rest', 'cli']);
  });

  it('falls through to authenticated gh when github.com REST has a recoverable server failure', async () => {
    const mod = await import('./authChain.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const error = Object.assign(new Error('GitHub REST request failed with status 502'), {
      errorCode: 'COMMAND_FAILED',
    });
    const calls: string[] = [];
    const adapter = mod.createGithubPullRequestAdapter({
      restAdapter: {
        createPullRequest: async () => {
          calls.push('rest');
          throw error;
        },
      },
      cliAdapter: {
        createPullRequest: async () => {
          calls.push('cli');
          return pullRequest;
        },
      },
    });

    await expect(adapter.createPullRequest({
      provider: githubProvider,
      base: 'main',
      head: 'feature/chain',
      title: 'Adapter chain',
    })).resolves.toEqual(pullRequest);
    expect(calls).toEqual(['rest', 'cli']);
  });

  it('falls through to authenticated gh when github.com REST has a network failure', async () => {
    const mod = await import('./authChain.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: string[] = [];
    const adapter = mod.createGithubPullRequestAdapter({
      restAdapter: {
        getPullRequest: async () => {
          calls.push('rest');
          throw new TypeError('fetch failed');
        },
      },
      cliAdapter: {
        getPullRequest: async () => {
          calls.push('cli');
          return pullRequest;
        },
      },
    });

    await expect(adapter.getPullRequest({
      provider: githubProvider,
      reference: { number: 3 },
    })).resolves.toEqual(pullRequest);
    expect(calls).toEqual(['rest', 'cli']);
  });

  it('does not fall through to gh for permanent REST errors', async () => {
    const mod = await import('./authChain.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const error = Object.assign(new Error('GitHub REST resource not found'), {
      errorCode: 'REMOTE_NOT_FOUND',
    });
    const calls: string[] = [];
    const adapter = mod.createGithubPullRequestAdapter({
      restAdapter: {
        listPullRequests: async () => {
          calls.push('rest');
          throw error;
        },
      },
      cliAdapter: {
        listPullRequests: async () => {
          calls.push('cli');
          return [pullRequest];
        },
      },
    });

    await expect(adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/chain',
    })).rejects.toBe(error);
    expect(calls).toEqual(['rest']);
  });

  it('skips github.com REST tokens for Enterprise hosts and tries gh', async () => {
    const mod = await import('./authChain.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: string[] = [];
    const adapter = mod.createGithubPullRequestAdapter({
      restAdapter: {
        listPullRequests: async () => {
          calls.push('rest');
          return [];
        },
      },
      cliAdapter: {
        listPullRequests: async () => {
          calls.push('cli');
          return [{ ...pullRequest, provider: enterpriseProvider }];
        },
      },
    });

    await expect(adapter.listPullRequests({
      provider: enterpriseProvider,
      head: 'feature/chain',
    })).resolves.toEqual([
      expect.objectContaining({ provider: enterpriseProvider }),
    ]);
    expect(calls).toEqual(['cli']);
  });
});
