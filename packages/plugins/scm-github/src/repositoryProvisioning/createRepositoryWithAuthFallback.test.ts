import type {
  ScmHostingProviderRef,
  ScmHostingRepositorySummary,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/experimental/scm';
import { describe, expect, it } from 'vitest';

const githubProvider: ScmHostingProviderRef = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  urlSafety: { allowedSchemes: ['https:'] },
};

const enterpriseProvider: ScmHostingProviderRef = {
  ...githubProvider,
  baseUrl: 'https://ghe.internal.test',
};

const repository: ScmHostingRepositorySummary = {
  provider: {
    ...githubProvider,
    nameWithOwner: 'happier-dev/happier',
  },
  nameWithOwner: 'happier-dev/happier',
  webUrl: 'https://github.com/happier-dev/happier',
  cloneUrl: 'https://github.com/happier-dev/happier.git',
  sshUrl: 'git@github.com:happier-dev/happier.git',
  visibility: 'private',
  defaultBranch: 'main',
};

describe('GitHub repository provisioning auth chain', () => {
  it('falls through to gh when REST auth is stale', async () => {
    const mod = await import('./createRepositoryWithAuthFallback.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const error = new Error('GitHub REST authentication failed');
    Object.assign(error, { errorCode: 'REMOTE_AUTH_REQUIRED' });
    const calls: string[] = [];
    const adapter = mod.createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          calls.push('rest');
          throw error;
        },
      },
      cliAdapter: {
        createRepository: async () => {
          calls.push('cli');
          return repository;
        },
      },
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
    })).resolves.toBe(repository);
    expect(calls).toEqual(['rest', 'cli']);
  });

  it('falls through to gh when github.com REST has a recoverable server failure', async () => {
    const mod = await import('./createRepositoryWithAuthFallback.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const error = Object.assign(new Error('GitHub REST request failed with status 502'), {
      errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    });
    const calls: string[] = [];
    const adapter = mod.createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          calls.push('rest');
          throw error;
        },
      },
      cliAdapter: {
        createRepository: async () => {
          calls.push('cli');
          return repository;
        },
      },
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
    })).resolves.toBe(repository);
    expect(calls).toEqual(['rest', 'cli']);
  });

  it('falls through to gh when github.com REST has a network failure', async () => {
    const mod = await import('./createRepositoryWithAuthFallback.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: string[] = [];
    const adapter = mod.createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          calls.push('rest');
          throw new TypeError('fetch failed');
        },
      },
      cliAdapter: {
        createRepository: async () => {
          calls.push('cli');
          return repository;
        },
      },
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
    })).resolves.toBe(repository);
    expect(calls).toEqual(['rest', 'cli']);
  });

  it('does not fall through to gh for permanent REST errors', async () => {
    const mod = await import('./createRepositoryWithAuthFallback.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const permanentErrors = [
      Object.assign(new Error('GitHub REST request was forbidden'), {
        errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED,
      }),
      Object.assign(new Error('GitHub repository was not found'), {
        errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
      }),
      Object.assign(new Error('GitHub REST request failed with status 422'), {
        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
      }),
    ] as const;

    for (const error of permanentErrors) {
      const calls: string[] = [];
      const adapter = mod.createGithubRepositoryProvisioningAdapter({
        restAdapter: {
          createRepository: async () => {
            calls.push('rest');
            throw error;
          },
        },
        cliAdapter: {
          createRepository: async () => {
            calls.push('cli');
            return repository;
          },
        },
      });

      await expect(adapter.createRepository({
        provider: githubProvider,
        owner: 'happier-dev',
        repositoryName: 'happier',
        visibility: 'private',
      })).rejects.toBe(error);
      expect(calls).toEqual(['rest']);
    }
  });

  it('skips REST for Enterprise hosts', async () => {
    const mod = await import('./createRepositoryWithAuthFallback.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: string[] = [];
    const adapter = mod.createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          calls.push('rest');
          return repository;
        },
      },
      cliAdapter: {
        createRepository: async () => {
          calls.push('cli');
          return { ...repository, provider: enterpriseProvider };
        },
      },
    });

    await expect(adapter.createRepository({
      provider: enterpriseProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
    })).resolves.toMatchObject({
      provider: enterpriseProvider,
    });
    expect(calls).toEqual(['cli']);
  });

  it('reports no-auth remediation for target discovery', async () => {
    const mod = await import('./createRepositoryWithAuthFallback.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        describePublishTargets: async () => {
          const error = new Error('GitHub REST authentication failed');
          Object.assign(error, { errorCode: 'REMOTE_AUTH_REQUIRED' });
          throw error;
        },
      },
      cliAdapter: {
        describePublishTargets: async () => {
          const error = new Error('GitHub CLI is not authenticated');
          Object.assign(error, { errorCode: 'REMOTE_AUTH_REQUIRED' });
          throw error;
        },
      },
    });

    await expect(adapter.describePublishTargets({
      provider: githubProvider,
      defaultRepositoryName: 'happier',
    })).resolves.toMatchObject({
      auth: {
        state: 'authentication_required',
        profileKind: 'no_auth',
        remediation: {
          kind: 'auth_required',
        },
      },
      targets: [],
    });
  });

  it('describes clone targets through provider-owned repository lookup', async () => {
    const mod = await import('./createRepositoryWithAuthFallback.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const calls: string[] = [];
    const adapter = mod.createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        getRepository: async (input: Readonly<{ owner: string; repositoryName: string }>) => {
          calls.push(`${input.owner}/${input.repositoryName}`);
          return repository;
        },
      },
      cliAdapter: {},
    });
    const describeCloneTargets = (adapter as {
      describeCloneTargets?: (input: Readonly<{
        provider: ScmHostingProviderRef;
        repository: {
          nameWithOwner: string;
          cloneUrl?: string;
          visibility: 'private' | 'public' | 'internal';
        };
      }>) => Promise<unknown>;
    }).describeCloneTargets;

    expect(describeCloneTargets).toEqual(expect.any(Function));
    if (!describeCloneTargets) return;

    await expect(describeCloneTargets({
      provider: githubProvider,
      repository: {
        nameWithOwner: 'happier-dev/happier',
        cloneUrl: 'file:///tmp/untrusted.git',
        visibility: 'private',
      },
    })).resolves.toMatchObject({
      auth: {
        state: 'authenticated',
        profileKind: 'connected_account',
      },
      repository: {
        nameWithOwner: 'happier-dev/happier',
        cloneUrl: 'https://github.com/happier-dev/happier.git',
        sshUrl: 'git@github.com:happier-dev/happier.git',
      },
      targets: [
        {
          protocol: 'https',
          url: 'https://github.com/happier-dev/happier.git',
          isDefault: true,
        },
        {
          protocol: 'ssh',
          url: 'git@github.com:happier-dev/happier.git',
        },
      ],
    });
    expect(calls).toEqual(['happier-dev/happier']);
  });
});
