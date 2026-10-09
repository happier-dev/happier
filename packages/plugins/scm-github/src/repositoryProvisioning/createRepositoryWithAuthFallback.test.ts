import type {
  HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingRepositorySummary,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it, vi } from 'vitest';

import { createGithubRepositoryProvisioningAdapter } from './createRepositoryWithAuthFallback.js';
import { createGithubRepositoryRestAdapter } from './githubRepositoryRestAdapter.js';

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
  it.each(['public', 'private', 'missing'] as const)('discovers public clone metadata anonymously, retaining bound-account authority for %s', async visibility => {
    const requests: Array<Readonly<{ url: string; authenticated: boolean }>> = [];
    const ambient = createAmbientProcessSpy();
    const adapter = createGithubRepositoryProvisioningAdapter({ restAdapter: createGithubRepositoryRestAdapter({
      fetcher: async (url, init) => {
        const authenticated = new Headers(init?.headers).has('Authorization');
        requests.push({ url, authenticated });
        const body = visibility === 'missing' ? { message: 'Not Found' } : { full_name: 'octocat/Hello-World',
          html_url: 'https://github.com/octocat/Hello-World', clone_url: 'https://github.com/octocat/Hello-World.git', visibility };
        return { ok: visibility !== 'missing', status: visibility === 'missing' ? 404 : 200, statusText: 'test',
          json: async () => body, text: async () => JSON.stringify(body) };
      },
    }) });
    const result = adapter.describeCloneTargets({ provider: githubProvider,
      repository: { nameWithOwner: 'octocat/Hello-World', visibility: 'public', cloneUrl: 'file:///untrusted.git' },
      runtimeServices: ambient.runtimeServices });
    if (visibility === 'public') {
      await expect(result).resolves.toMatchObject({ auth: { profileKind: 'no_auth' },
        targets: [{ protocol: 'https', url: 'https://github.com/octocat/Hello-World.git', isDefault: true }] });
    } else {
      await expect(result).rejects.toMatchObject({ errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED });
    }
    expect(requests).toEqual([{ url: 'https://api.github.com/repos/octocat/Hello-World', authenticated: false }]);
    expect(ambient.executeCommand).not.toHaveBeenCalled();
  });

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
          action: 'connect_github',
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
    const calls: boolean[] = [];
    const adapter = createGithubRepositoryProvisioningAdapter({
      restAdapter: createGithubRepositoryRestAdapter({
        resolveToken: async () => ({ kind: 'available', token: 'test-bound-token' }),
        fetcher: async (url, init) => {
          expect(url).toBe('https://api.github.com/repos/happier-dev/happier');
          const authenticated = new Headers(init?.headers).has('Authorization');
          calls.push(authenticated);
          const body = authenticated ? { full_name: repository.nameWithOwner, html_url: repository.webUrl,
            clone_url: repository.cloneUrl, ssh_url: repository.sshUrl, visibility: 'private' } : { message: 'Not Found' };
          return { ok: authenticated, status: authenticated ? 200 : 404, statusText: 'test',
            json: async () => body, text: async () => JSON.stringify(body) };
        },
      }),
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
    expect(calls).toEqual([false, true]);
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
