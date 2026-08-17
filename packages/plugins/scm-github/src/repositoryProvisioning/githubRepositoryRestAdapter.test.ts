import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
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

function jsonResponse(body: unknown, init?: Readonly<{ status?: number; statusText?: string }>) {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init?.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('GitHub REST repository provisioning adapter', () => {
  it('lists REST publish targets for authenticated principals', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token', profileKey: 'github:work' }),
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === 'https://api.github.com/user') {
          return jsonResponse({ login: 'octocat', name: 'Octo Cat' });
        }
        if (url === 'https://api.github.com/user/orgs') {
          return jsonResponse([{ login: 'happier-dev' }]);
        }
        return jsonResponse({}, { status: 500 });
      },
    });

    await expect(adapter.describePublishTargets({
      provider: githubProvider,
      defaultRepositoryName: 'happier',
    })).resolves.toMatchObject({
      auth: {
        state: 'authenticated',
        profileKind: 'connected_account',
        profileKey: 'github:work',
      },
      targets: [
        {
          owner: 'octocat',
          ownerKind: 'user',
          label: 'Octo Cat',
          isDefault: true,
          supportedVisibilities: ['private', 'public'],
        },
        {
          owner: 'happier-dev',
          ownerKind: 'org',
          supportedVisibilities: ['private', 'public', 'internal'],
        },
      ],
    });
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.github.com/user',
      'https://api.github.com/user/orgs',
    ]);
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: ['Bearer', 'redacted-test-token'].join(' '),
    });
  });

  it('uses operation-scoped runtime token materialization when constructor token resolver is absent', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = mod.createGithubRepositoryRestAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return url.endsWith('/user')
          ? jsonResponse({ login: 'octocat' })
          : jsonResponse([]);
      },
    });

    await expect(adapter.describePublishTargets({
      provider: githubProvider,
      defaultRepositoryName: 'happier',
      runtimeServices: {
        resolveScmHostingTokenMaterialization: async () => ({
          kind: 'available',
          token: 'runtime-redacted-token',
          profileKey: 'github:runtime',
        }),
      },
    })).resolves.toMatchObject({
      auth: {
        state: 'authenticated',
        profileKey: 'github:runtime',
      },
    });

    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer runtime-redacted-token',
    });
  });

  it('creates repositories through REST owner endpoints', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse({
          name: 'happier',
          full_name: 'happier-dev/happier',
          html_url: 'https://github.com/happier-dev/happier',
          clone_url: 'https://github.com/happier-dev/happier.git',
          ssh_url: 'git@github.com:happier-dev/happier.git',
          visibility: 'private',
          default_branch: 'main',
        });
      },
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      ownerKind: 'org',
      repositoryName: 'happier',
      visibility: 'internal',
      description: '  Test repository  ',
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/happier',
      webUrl: 'https://github.com/happier-dev/happier',
      cloneUrl: 'https://github.com/happier-dev/happier.git',
      sshUrl: 'git@github.com:happier-dev/happier.git',
      visibility: 'private',
      defaultBranch: 'main',
    });
    expect(requests[0]?.url).toBe('https://api.github.com/orgs/happier-dev/repos');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      name: 'happier',
      visibility: 'internal',
      description: 'Test repository',
    });
  });

  it('returns null for missing REST repositories', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({ message: 'not found' }, { status: 404, statusText: 'Not Found' }),
    });

    await expect(adapter.getRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'missing',
    })).resolves.toBeNull();
  });

  it('maps REST forbidden responses to remote rejection instead of authentication required', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({ message: 'Resource not accessible by token' }, { status: 403, statusText: 'Forbidden' }),
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      ownerKind: 'org',
      repositoryName: 'happier',
      visibility: 'private',
    })).rejects.toMatchObject({
      errorCode: 'REMOTE_REJECTED',
    });
  });

  it('maps REST already-exists validation responses to remote already exists', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({
        message: 'Repository creation failed.',
        errors: [
          {
            resource: 'Repository',
            code: 'custom',
            field: 'name',
            message: 'name already exists on this account',
          },
        ],
      }, { status: 422, statusText: 'Unprocessable Entity' }),
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      ownerKind: 'org',
      repositoryName: 'happier',
      visibility: 'private',
    })).rejects.toMatchObject({
      errorCode: 'REMOTE_ALREADY_EXISTS',
    });
  });

  it('uses Enterprise REST API base with host-eligible tokens', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: string[] = [];
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async ({ host }: Readonly<{ host: string }>) => (
        host === 'ghe.internal.test'
          ? { kind: 'available', token: 'enterprise-redacted-test-token' }
          : { kind: 'missing', reason: 'unsupported_host' }
      ),
      fetcher: async (url: string) => {
        requests.push(url);
        return jsonResponse({
          full_name: 'happier-dev/happier',
          html_url: 'https://ghe.internal.test/happier-dev/happier',
          clone_url: 'https://ghe.internal.test/happier-dev/happier.git',
          ssh_url: 'git@ghe.internal.test:happier-dev/happier.git',
          visibility: 'public',
          default_branch: 'main',
        });
      },
    });

    await expect(adapter.getRepository({
      provider: enterpriseProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/happier',
      webUrl: 'https://ghe.internal.test/happier-dev/happier',
    });
    expect(requests).toEqual([
      'https://ghe.internal.test/api/v3/repos/happier-dev/happier',
    ]);
  });

  it('rejects Enterprise REST base URLs with path components', async () => {
    const mod = await import('./githubRepositoryRestAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'enterprise-redacted-test-token' }),
      fetcher: async () => jsonResponse({}),
    });

    await expect(adapter.getRepository({
      provider: {
        ...enterpriseProvider,
        baseUrl: 'https://ghe.internal.test/api',
      },
      owner: 'happier-dev',
      repositoryName: 'happier',
    })).rejects.toMatchObject({
      errorCode: 'COMMAND_FAILED',
    });
  });
});
