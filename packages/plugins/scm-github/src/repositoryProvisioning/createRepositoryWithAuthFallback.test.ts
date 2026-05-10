import type {
  ScmHostingProviderRef,
  ScmHostingRepositorySummary,
} from '@happier-dev/protocol';
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
