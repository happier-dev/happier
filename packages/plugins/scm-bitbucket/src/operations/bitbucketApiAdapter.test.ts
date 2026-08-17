import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import type { HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { describe, expect, it } from 'vitest';

const provider: ScmHostingProviderRef = {
  id: 'happier.scm.forge.bitbucket/bitbucket',
  kind: 'bitbucket',
  displayName: 'Bitbucket',
  baseUrl: 'https://bitbucket.org',
  nameWithOwner: 'happier-dev/happier',
  urlSafety: {
    allowedSchemes: ['https:'],
    allowedBaseUrls: ['https://bitbucket.org'],
    allowedOrigins: ['https://bitbucket.org'],
  },
};

function encodeBasicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

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

function createRuntimeServices(): ScmHostingProviderRuntimeServices {
  return {
    resolveScmHostingBasicAuthMaterialization: async (request) => ({
      kind: 'available',
      username: `user-for-${request.host}`,
      password: 'redacted-app-password',
      profileKey: 'bitbucket:work',
    }),
  };
}

function createBitbucketPullRequest(overrides?: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 42,
    title: 'Add Bitbucket operations',
    state: 'OPEN',
    links: {
      html: {
        href: 'https://bitbucket.org/happier-dev/happier/pull-requests/42',
      },
    },
    source: {
      branch: { name: 'feature/bitbucket' },
      commit: { hash: 'head-sha' },
      repository: {
        full_name: 'happier-dev/happier',
      },
    },
    destination: {
      branch: { name: 'main' },
      commit: { hash: 'base-sha' },
      repository: {
        full_name: 'happier-dev/happier',
      },
    },
    author: {
      nickname: 'dev',
      display_name: 'Dev User',
      links: {
        html: {
          href: 'https://bitbucket.org/dev',
        },
      },
    },
    ...overrides,
  };
}

describe('Bitbucket API adapter', () => {
  it('lists valid pull requests, skips malformed rows, and preserves decode diagnostics', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse({
          values: [
            createBitbucketPullRequest(),
            { id: 100, title: '', source: { branch: { name: 'bad' } } },
          ],
        });
      },
    });
    const controller = new AbortController();

    await expect(adapter.listPullRequests({
      provider,
      base: 'main',
      head: 'feature/bitbucket',
      state: 'open',
      runtimeServices: createRuntimeServices(),
      signal: controller.signal,
    })).resolves.toEqual([
      expect.objectContaining({
        number: 42,
        title: 'Add Bitbucket operations',
        baseBranch: 'main',
        headBranch: 'feature/bitbucket',
        headRepositoryNameWithOwner: 'happier-dev/happier',
        state: 'open',
      }),
    ]);

    const decoded = mod.decodeBitbucketPullRequestList(provider, {
      values: [
        createBitbucketPullRequest(),
        { id: 100, title: '', source: { branch: { name: 'bad' } } },
      ],
    });
    expect(decoded.pullRequests).toHaveLength(1);
    expect(decoded.diagnostics).toEqual([
      expect.stringContaining('index 1'),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('https://api.bitbucket.org/2.0/repositories/happier-dev/happier/pullrequests?');
    expect(requests[0]?.url).toContain('state=OPEN');
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: encodeBasicAuth('user-for-bitbucket.org', 'redacted-app-password'),
    });
    expect(requests[0]?.init?.signal).toBe(controller.signal);
  });

  it('requires source repository identity when Bitbucket sends a source repository object', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const decoded = mod.decodeBitbucketPullRequestList(provider, {
      values: [
        createBitbucketPullRequest({
          id: 9,
          source: {
            branch: { name: 'feature/incomplete-source' },
            repository: { name: 'happier' },
          },
        }),
        createBitbucketPullRequest({
          id: 10,
          source: {
            branch: { name: 'feature/fork' },
            repository: { full_name: 'other-workspace/happier-fork' },
          },
        }),
      ],
    });

    expect(decoded.pullRequests).toEqual([
      expect.objectContaining({
        number: 10,
        headRepositoryNameWithOwner: 'other-workspace/happier-fork',
        isCrossRepository: true,
      }),
    ]);
    expect(decoded.diagnostics).toEqual([
      expect.stringContaining('index 0'),
    ]);
  });

  it('creates pull requests with JSON request bodies and maps checkout metadata', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse(createBitbucketPullRequest());
      },
    });

    await expect(adapter.createPullRequest({
      provider,
      base: 'main',
      head: 'feature/bitbucket',
      title: 'Add Bitbucket operations',
      body: 'Large body stays in the JSON request body, not in the URL.',
      runtimeServices: createRuntimeServices(),
    })).resolves.toMatchObject({
      number: 42,
      headSha: 'head-sha',
      baseSha: 'base-sha',
    });

    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.url).not.toContain('Large%20body');
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      title: 'Add Bitbucket operations',
      description: 'Large body stays in the JSON request body, not in the URL.',
      source: { branch: { name: 'feature/bitbucket' } },
      destination: { branch: { name: 'main' } },
    });

    await expect(adapter.resolvePullRequestCheckoutReference({
      provider,
      reference: { number: 42 },
      runtimeServices: createRuntimeServices(),
    })).resolves.toMatchObject({
      branch: 'feature/bitbucket',
      headSha: 'head-sha',
      baseSha: 'base-sha',
      pullRequest: {
        number: 42,
      },
    });
  });

  it('rejects pull request URL references from another Bitbucket repository before fetching', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: unknown[] = [];
    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse({});
      },
    });

    await expect(adapter.getPullRequest({
      provider,
      reference: { url: 'https://bitbucket.org/other-owner/other-repo/pull-requests/42' },
      runtimeServices: createRuntimeServices(),
    })).resolves.toBeNull();
    expect(requests).toEqual([]);
  });

  it('rejects unsafe Bitbucket provider and pull request reference URLs before fetching', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: unknown[] = [];
    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse({});
      },
    });

    await expect(adapter.listPullRequests({
      provider: {
        ...provider,
        baseUrl: 'https://user:secret@bitbucket.org',
      },
      head: 'feature/unsafe',
      runtimeServices: createRuntimeServices(),
    })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
    });

    for (const url of [
      'https://user:secret@bitbucket.org/happier-dev/happier/pull-requests/42',
      'https://bitbucket.org:8443/happier-dev/happier/pull-requests/42',
      'https://bitbucket.org/happier-dev/happier/pull-requests/42?token=secret',
      'https://bitbucket.org/happier-dev/happier/pull-requests/42#secret',
    ]) {
      await expect(adapter.getPullRequest({
        provider,
        reference: { url },
        runtimeServices: createRuntimeServices(),
      })).resolves.toBeNull();
    }

    expect(requests).toEqual([]);
  });

  it('reuses duplicate pull requests only when branch-head context matches', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return jsonResponse({
            error: { message: 'There is already an open pull request.' },
          }, { status: 409, statusText: 'Conflict' });
        }
        return jsonResponse({
          values: [
            createBitbucketPullRequest({
              id: 7,
              source: {
                branch: { name: 'feature/other' },
                repository: { full_name: 'happier-dev/happier' },
              },
            }),
          ],
        });
      },
    });

    await expect(adapter.openOrReusePullRequest({
      provider,
      base: 'main',
      head: 'feature/bitbucket',
      title: 'Add Bitbucket operations',
      runtimeServices: createRuntimeServices(),
    })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
    });
  });

  it('rejects under-specified duplicate hints without source repository identity', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return jsonResponse({
            error: { message: 'There is already an open pull request.' },
            pullrequest: createBitbucketPullRequest({
              id: 77,
              source: {
                branch: { name: 'feature/bitbucket' },
                repository: { name: 'happier' },
              },
            }),
          }, { status: 409, statusText: 'Conflict' });
        }
        return jsonResponse({ values: [] });
      },
    });

    await expect(adapter.openOrReusePullRequest({
      provider,
      base: 'main',
      head: 'feature/bitbucket',
      title: 'Add Bitbucket operations',
      runtimeServices: createRuntimeServices(),
    })).rejects.toMatchObject({
      errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
    });
  });

  it('describes Bitbucket publish targets and creates repositories through API payloads', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse({
          full_name: 'happier-dev/next-repo',
          links: {
            html: { href: 'https://bitbucket.org/happier-dev/next-repo' },
            clone: [
              { name: 'https', href: 'https://bitbucket.org/happier-dev/next-repo.git' },
              { name: 'ssh', href: 'git@bitbucket.org:happier-dev/next-repo.git' },
            ],
          },
          is_private: true,
          mainbranch: { name: 'main' },
        });
      },
    });

    await expect(adapter.describePublishTargets({
      provider,
      defaultRepositoryName: 'next-repo',
      runtimeServices: createRuntimeServices(),
    })).resolves.toMatchObject({
      auth: {
        state: 'authenticated',
        profileKind: 'connected_account',
        profileKey: 'bitbucket:work',
      },
      targets: [
        expect.objectContaining({
          owner: 'happier-dev',
          ownerKind: 'org',
          supportedRemoteUrlKinds: ['https', 'ssh'],
        }),
      ],
    });

    await expect(adapter.createRepository({
      provider,
      owner: 'happier-dev',
      ownerKind: 'org',
      repositoryName: 'next-repo',
      visibility: 'private',
      description: 'Created from Happier',
      runtimeServices: createRuntimeServices(),
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/next-repo',
      webUrl: 'https://bitbucket.org/happier-dev/next-repo',
      cloneUrl: 'https://bitbucket.org/happier-dev/next-repo.git',
      sshUrl: 'git@bitbucket.org:happier-dev/next-repo.git',
      visibility: 'private',
      defaultBranch: 'main',
    });

    expect(requests.at(-1)?.url).toBe('https://api.bitbucket.org/2.0/repositories/happier-dev/next-repo');
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toMatchObject({
      scm: 'git',
      is_private: true,
      description: 'Created from Happier',
    });
  });

  it('gets repositories and returns null for Bitbucket 404 responses', async () => {
    const mod = await import('./bitbucketApiAdapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.createBitbucketApiAdapter({
      fetcher: async (url: string) => {
        if (url.endsWith('/missing-repo')) {
          return jsonResponse({ error: { message: 'Not found' } }, { status: 404, statusText: 'Not Found' });
        }
        return jsonResponse({
          full_name: 'happier-dev/existing-repo',
          links: {
            html: { href: 'https://bitbucket.org/happier-dev/existing-repo' },
            clone: [
              { name: 'https', href: 'https://bitbucket.org/happier-dev/existing-repo.git' },
            ],
          },
          is_private: false,
          mainbranch: { name: 'main' },
        });
      },
    });

    await expect(adapter.getRepository({
      provider,
      owner: 'happier-dev',
      repositoryName: 'existing-repo',
      runtimeServices: createRuntimeServices(),
    })).resolves.toMatchObject({
      nameWithOwner: 'happier-dev/existing-repo',
      visibility: 'public',
      defaultBranch: 'main',
    });

    await expect(adapter.getRepository({
      provider,
      owner: 'happier-dev',
      repositoryName: 'missing-repo',
      runtimeServices: createRuntimeServices(),
    })).resolves.toBeNull();
  });
});
