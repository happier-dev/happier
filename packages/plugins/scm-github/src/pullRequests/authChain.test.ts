import type {
  HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it, vi } from 'vitest';

import { createGithubPullRequestAdapter } from './authChain.js';

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

/**
 * The bound Connected Account is the sole authenticated authority, so no
 * operation may reach the machine's ambient `gh`. `executeCommand` is the only
 * process seam the GitHub CLI path can use, so a never-called spy on it
 * falsifies any ambient-credential fallback.
 */
function createAmbientProcessSpy() {
  const executeCommand = vi.fn(async () => ({
    ok: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
  }));
  return {
    executeCommand,
    runtimeServices: { executeCommand } as unknown as ScmHostingProviderRuntimeServices,
  };
}

describe('GitHub pull request adapter authority', () => {
  it('serves github.com pull requests from the bound-account REST adapter alone', async () => {
    const ambient = createAmbientProcessSpy();
    const calls: string[] = [];
    const adapter = createGithubPullRequestAdapter({
      restAdapter: {
        listPullRequests: async () => {
          calls.push('rest');
          return [pullRequest];
        },
      },
    });

    await expect(adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/chain',
      runtimeServices: ambient.runtimeServices,
    })).resolves.toEqual([pullRequest]);
    expect(calls).toEqual(['rest']);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('fails typed instead of running ambient gh when the bound account is unauthenticated', async () => {
    const ambient = createAmbientProcessSpy();
    const error = Object.assign(new Error('GitHub REST authentication failed'), {
      errorCode: 'REMOTE_AUTH_REQUIRED',
    });
    const adapter = createGithubPullRequestAdapter({
      restAdapter: {
        listPullRequests: async () => {
          throw error;
        },
      },
    });

    await expect(adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/chain',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toBe(error);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('fails a pull-request mutation typed instead of running ambient gh on a recoverable REST status', async () => {
    const ambient = createAmbientProcessSpy();
    const error = Object.assign(new Error('GitHub REST request failed with status 502'), {
      errorCode: 'COMMAND_FAILED',
    });
    const adapter = createGithubPullRequestAdapter({
      restAdapter: {
        createPullRequest: async () => {
          throw error;
        },
      },
    });

    await expect(adapter.createPullRequest({
      provider: githubProvider,
      base: 'main',
      head: 'feature/chain',
      title: 'Adapter chain',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toBe(error);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('propagates a REST network failure instead of running ambient gh', async () => {
    const ambient = createAmbientProcessSpy();
    const error = new TypeError('fetch failed');
    const adapter = createGithubPullRequestAdapter({
      restAdapter: {
        getPullRequest: async () => {
          throw error;
        },
      },
    });

    await expect(adapter.getPullRequest({
      provider: githubProvider,
      reference: { number: 3 },
      runtimeServices: ambient.runtimeServices,
    })).rejects.toBe(error);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('refuses GitHub Enterprise hosts typed because they have no bound-account path', async () => {
    const ambient = createAmbientProcessSpy();
    const calls: string[] = [];
    const adapter = createGithubPullRequestAdapter({
      restAdapter: {
        listPullRequests: async () => {
          calls.push('rest');
          return [];
        },
      },
    });

    await expect(adapter.listPullRequests({
      provider: enterpriseProvider,
      head: 'feature/chain',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toMatchObject({ errorCode: 'REMOTE_AUTH_REQUIRED' });
    expect(calls).toEqual([]);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('refuses an Enterprise pull-request mutation typed', async () => {
    const ambient = createAmbientProcessSpy();
    const adapter = createGithubPullRequestAdapter({
      restAdapter: {
        createPullRequest: async () => pullRequest,
      },
    });

    await expect(adapter.createPullRequest({
      provider: enterpriseProvider,
      base: 'main',
      head: 'feature/chain',
      title: 'Adapter chain',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toMatchObject({ errorCode: 'REMOTE_AUTH_REQUIRED' });
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });
});
