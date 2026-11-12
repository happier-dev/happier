import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { describe, expect, it } from 'vitest';
import * as mod from './githubRepositoryRestAdapter.js';
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

function jsonResponse(body: unknown, init?: Readonly<{
  status?: number;
  statusText?: string;
  headers?: Readonly<Record<string, string>>;
}>) {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init?.statusText ?? 'OK',
    ...(init?.headers ? { headers: new Headers(init.headers) } : {}),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('GitHub REST repository provisioning adapter', () => {
  it.each([200, 404, 403, 410])('resolves latest stable only, falls back on no release, preserves HTTP failure (%s)', async status => {
    const requests: string[] = [];
    const adapter = createGithubRepositoryProvisioningAdapter({ restAdapter: mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'release-test-token' }),
      fetcher: async url => {
        requests.push(url);
        if (url.endsWith('/releases/latest')) return status === 200 ? jsonResponse({
          id: 7, tag_name: 'v1.0.0', target_commitish: 'develop', name: 'Stable', body: null,
          draft: false, prerelease: false, assets: [], created_at: '2026-01-01T00:00:00Z',
          published_at: '2026-01-02T00:00:00Z', html_url: 'https://github.com/alice/starter/releases/tag/v1.0.0',
        }) : jsonResponse({ message: status === 404 ? 'Not Found' : 'Forbidden' }, { status });
        return jsonResponse({ id: 42, full_name: 'alice/starter', html_url: 'https://github.com/alice/starter',
          clone_url: 'https://github.com/alice/starter.git', visibility: 'public', default_branch: 'develop' });
      },
    }) });
    const result = adapter.describeCloneTargets({ provider: githubProvider, repository: { nameWithOwner: 'alice/starter' }, revision: 'latest-stable' });
    if (status === 403 || status === 410) await expect(result).rejects.toMatchObject({ errorCode: status === 403 ? 'REMOTE_REJECTED' : 'REMOTE_NOT_FOUND' });
    else await expect(result).resolves.toMatchObject({ initialCheckoutRef: status === 200 ? 'refs/tags/v1.0.0' : 'HEAD' });
    expect(requests).toEqual(['https://api.github.com/repos/alice/starter', 'https://api.github.com/repos/alice/starter/releases/latest']);
  });

  it.each(['draft', 'prerelease', 'malformed'])('does not fall back when the latest-release response is %s', async mode => {
    const adapter = createGithubRepositoryProvisioningAdapter({ restAdapter: mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'invalid-release-test-token' }),
      fetcher: async url => url.endsWith('/releases/latest') ? jsonResponse(mode === 'malformed' ? {} : {
        id: 7, tag_name: 'v2.0.0', target_commitish: 'develop', name: 'Unstable',
        draft: mode === 'draft', prerelease: mode === 'prerelease', assets: [],
        created_at: '2026-01-01T00:00:00Z', published_at: '2026-01-02T00:00:00Z',
        html_url: 'https://github.com/alice/starter/releases/tag/v2.0.0',
      }) : jsonResponse({ id: 42, full_name: 'alice/starter', html_url: 'https://github.com/alice/starter',
        clone_url: 'https://github.com/alice/starter.git', visibility: 'public', default_branch: 'develop' }),
    }) });
    await expect(adapter.describeCloneTargets({ provider: githubProvider, repository: { nameWithOwner: 'alice/starter' }, revision: 'latest-stable' }))
      .rejects.toMatchObject({ errorCode: 'COMMAND_FAILED' });
  });

  it('uses the host-selected native login to discover a private clone without requiring an imported account', async () => {
    const adapter = mod.createGithubRepositoryRestAdapter({
      fetcher: async (_url, init) => new Headers(init?.headers).get('authorization') === 'Bearer native-test-token'
        ? jsonResponse({ full_name: 'happier-dev/triage-qa-sandbox',
          html_url: 'https://github.com/happier-dev/triage-qa-sandbox',
          clone_url: 'https://github.com/happier-dev/triage-qa-sandbox.git', visibility: 'private' })
        : jsonResponse({ message: 'Not Found' }, { status: 404 }),
    });
    await expect(adapter.getRepositoryForClone({ provider: githubProvider, owner: 'happier-dev',
      repositoryName: 'triage-qa-sandbox', runtimeServices: {
        // SDK host boundary: bound-only excludes this Machine's selected native login.
        resolveScmHostingTokenMaterialization: async request => request.boundAccountOnly
          ? { kind: 'missing', reason: 'account_unbound' }
          : { kind: 'available', token: 'native-test-token' },
      },
    })).resolves.toMatchObject({ repository: { visibility: 'private' }, auth: { state: 'authenticated', profileKind: 'provider_cli' } });
  });

  it('preserves the materialization precondition when no credential can be acquired', async () => {
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'missing', reason: 'credential_unavailable' }),
      fetcher: async () => { throw new Error('Credential refusal must precede HTTP'); },
    });
    await expect(adapter.getRepositoryForClone({ provider: githubProvider, owner: 'happier-dev',
      repositoryName: 'triage-qa-sandbox' })).rejects.toMatchObject({ errorCode: 'REMOTE_AUTH_REQUIRED',
      failureCause: { phase: 'scm.repository_auth.materialization', errorClass: 'Error', errorCode: null, httpStatus: null } });
  });

  it('blocks later repository invocations after GitHub throttles the account', async () => {
    let requests = 0;
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'backoff-token', profileKey: 'github:backoff' }),
      fetcher: async () => {
        requests += 1;
        return jsonResponse({ message: 'Secondary rate limit' }, {
          status: 403,
          headers: { 'retry-after': '60' },
        });
      },
    });
    const input = { provider: githubProvider, owner: 'happier-dev', repositoryName: 'happier' };

    await expect(adapter.getRepository(input)).rejects.toMatchObject({ errorCode: 'REMOTE_RATE_LIMITED' });
    await expect(adapter.getRepository(input)).rejects.toMatchObject({ errorCode: 'REMOTE_RATE_LIMITED' });
    expect(requests).toBe(1);
  });

  it('shares simultaneous repository reads but releases the response after settlement', async () => {
    let requests = 0;
    let release = () => {};
    let notifyStarted = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'coalesced-token', profileKey: 'github:coalesced' }),
      fetcher: async () => {
        requests += 1;
        notifyStarted();
        await pending;
        return jsonResponse({
          full_name: 'happier-dev/happier',
          html_url: 'https://github.com/happier-dev/happier',
          visibility: 'public',
        });
      },
    });
    const input = { provider: githubProvider, owner: 'happier-dev', repositoryName: 'happier' };
    const first = adapter.getRepository(input);
    const second = adapter.getRepository(input);
    await started;
    release();

    const values = await Promise.all([first, second]);
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({ nameWithOwner: 'happier-dev/happier' });
    expect(values[1]).toEqual(values[0]);
    expect(requests).toBe(1);
    await expect(adapter.getRepository(input)).resolves.toEqual(values[0]);
    expect(requests).toBe(2);
  });

  it('lists REST publish targets for authenticated principals', async () => {
    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token', profileKey: 'github:work' }),
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (!new Headers(init?.headers).get('user-agent')?.trim()) {
          return jsonResponse({ message: 'User-Agent required' }, { status: 403 });
        }
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

  it('identifies anonymous public-repository clone reads without fabricating authorization', async () => {
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'missing', reason: 'account_unbound' }),
      fetcher: async (_url, init) => {
        const headers = new Headers(init?.headers);
        if (!headers.get('user-agent')?.trim() || headers.has('authorization')) {
          return jsonResponse({ message: 'Invalid anonymous request headers' }, { status: 403 });
        }
        return jsonResponse({
          full_name: 'happier-dev/happier',
          html_url: 'https://github.com/happier-dev/happier',
          clone_url: 'https://github.com/happier-dev/happier.git',
          visibility: 'public',
          default_branch: 'main',
        });
      },
    });

    await expect(adapter.getRepositoryForClone({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
    })).resolves.toMatchObject({
      repository: { nameWithOwner: 'happier-dev/happier', visibility: 'public' },
      auth: { state: 'authenticated', profileKind: 'no_auth' },
    });
  });

  it('creates repositories through REST owner endpoints', async () => {
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
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      name: 'happier',
      visibility: 'internal',
      description: 'Test repository',
    });
  });

  it('returns null for missing REST repositories', async () => {
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

  it('classifies a throttled GitHub 403 as a retryable backend limit, not a remote rejection', async () => {
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({ message: 'API rate limit exceeded for user ID 1.' }, {
        status: 403,
        statusText: 'Forbidden',
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1900000000',
        },
      }),
    });

    await expect(adapter.createRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      ownerKind: 'org',
      repositoryName: 'happier',
      visibility: 'private',
    })).rejects.toMatchObject({
      errorCode: 'REMOTE_RATE_LIMITED',
      retryNotBeforeMs: 1900000000000,
    });
  });

  it('classifies a secondary-limit GitHub 403 with a Retry-After instruction as a backend limit', async () => {
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      }, {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Retry-After': '60' },
      }),
    });

    await expect(adapter.getRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'happier',
    })).rejects.toMatchObject({
      errorCode: 'REMOTE_RATE_LIMITED',
      retryNotBeforeMs: expect.any(Number),
    });
  });

  it('treats a GitHub 410 as an unreachable repository rather than a generic command failure', async () => {
    const adapter = mod.createGithubRepositoryRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({ message: 'gone' }, { status: 410, statusText: 'Gone' }),
    });

    await expect(adapter.getRepository({
      provider: githubProvider,
      owner: 'happier-dev',
      repositoryName: 'retired',
    })).resolves.toBeNull();
  });
});
