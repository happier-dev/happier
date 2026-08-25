import type {
  HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingRepositorySummary,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it, vi } from 'vitest';

import { createGithubRepositoryProvisioningAdapter } from './createRepositoryWithAuthFallback.js';

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

/**
 * `executeCommand` is the only process seam the GitHub CLI path can use, so a
 * never-called spy on it falsifies any ambient-credential fallback.
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

describe('GitHub repository provisioning authority', () => {
  it('fails repository creation typed instead of running ambient gh when the bound account is unauthenticated', async () => {
    const ambient = createAmbientProcessSpy();
    const error = Object.assign(new Error('GitHub REST authentication failed'), {
      errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
    });
    const calls: string[] = [];
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          calls.push('rest');
          throw error;
        },
      },
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toBe(error);
    expect(calls).toEqual(['rest']);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('fails repository creation typed instead of running ambient gh on a recoverable REST status', async () => {
    const ambient = createAmbientProcessSpy();
    const error = Object.assign(new Error('GitHub REST request failed with status 502'), {
      errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    });
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          throw error;
        },
      },
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toBe(error);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('propagates a REST network failure instead of running ambient gh', async () => {
    const ambient = createAmbientProcessSpy();
    const error = new TypeError('fetch failed');
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          throw error;
        },
      },
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toBe(error);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('propagates permanent REST errors', async () => {
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
      const ambient = createAmbientProcessSpy();
      const calls: string[] = [];
      const adapter = createGithubRepositoryProvisioningAdapter({
        restAdapter: {
          createRepository: async () => {
            calls.push('rest');
            throw error;
          },
        },
      });

      await expect(adapter.createRepository({
        provider: githubProvider,
        owner: 'happier-dev',
        repositoryName: 'happier',
        visibility: 'private',
        runtimeServices: ambient.runtimeServices,
      })).rejects.toBe(error);
      expect(calls).toEqual(['rest']);
      expect(ambient.executeCommand).not.toHaveBeenCalled();
    }
  });

  it('refuses Enterprise repository creation typed because it has no bound-account path', async () => {
    const ambient = createAmbientProcessSpy();
    const calls: string[] = [];
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        createRepository: async () => {
          calls.push('rest');
          return repository;
        },
      },
    });

    await expect(adapter.createRepository({
      provider: enterpriseProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
      visibility: 'private',
      runtimeServices: ambient.runtimeServices,
    })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
    });
    expect(calls).toEqual([]);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('reports no-auth remediation for target discovery when the bound account is unauthenticated', async () => {
    const ambient = createAmbientProcessSpy();
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        describePublishTargets: async () => {
          const error = new Error('GitHub REST authentication failed');
          Object.assign(error, { errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED });
          throw error;
        },
      },
    });

    await expect(adapter.describePublishTargets({
      provider: githubProvider,
      defaultRepositoryName: 'happier',
      runtimeServices: ambient.runtimeServices,
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
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('reports no-auth remediation for Enterprise target discovery without running ambient gh', async () => {
    const ambient = createAmbientProcessSpy();
    const calls: string[] = [];
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        describePublishTargets: async () => {
          calls.push('rest');
          throw new Error('unreachable');
        },
      },
    });

    await expect(adapter.describePublishTargets({
      provider: enterpriseProvider,
      defaultRepositoryName: 'happier',
      runtimeServices: ambient.runtimeServices,
    })).resolves.toMatchObject({
      auth: {
        state: 'authentication_required',
        profileKind: 'no_auth',
      },
      targets: [],
    });
    expect(calls).toEqual([]);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

  it('describes clone targets through provider-owned repository lookup', async () => {
    const calls: string[] = [];
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        getRepository: async (input: Readonly<{ owner: string; repositoryName: string }>) => {
          calls.push(`${input.owner}/${input.repositoryName}`);
          return repository;
        },
      },
    });

    await expect(adapter.describeCloneTargets({
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

  it('refuses Enterprise clone-target description typed without running ambient gh', async () => {
    const ambient = createAmbientProcessSpy();
    const calls: string[] = [];
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: {
        getRepository: async () => {
          calls.push('rest');
          return repository;
        },
      },
    });

    await expect(adapter.describeCloneTargets({
      provider: enterpriseProvider,
      repository: {
        nameWithOwner: 'happier-dev/happier',
        visibility: 'private',
      },
      runtimeServices: ambient.runtimeServices,
    })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
    });
    expect(calls).toEqual([]);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });
});
