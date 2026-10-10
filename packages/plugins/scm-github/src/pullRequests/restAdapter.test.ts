import type { HostingProviderRuntimeServices, ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { describe, expect, it } from 'vitest';
import { GITHUB_API_VERSION } from '../observations/githubProviderContracts.js';
import { createGithubRestAdapter } from './restAdapter.js';

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

describe('GitHub REST pull request adapter', () => {
  it('cancels pending host credential materialization before making an HTTP request', async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('Cancelled', 'AbortError');
    const requests: string[] = [];
    let materializationCancelled = false;
    let endMaterialization = () => {};
    let notifyStarted = () => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    // The plugin host service is the process boundary that owns the native gh
    // subprocess. Keep the real REST adapter and runtime resolver underneath it.
    const runtimeServices: HostingProviderRuntimeServices = {
      resolveScmHostingTokenMaterialization: async (_request, options) => {
        const pending = new Promise<never>((_resolve, reject) => {
          endMaterialization = () => reject(abortReason);
          const signal = options?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              materializationCancelled = true;
              reject(signal.reason);
            }, { once: true });
          }
        });
        notifyStarted();
        return pending;
      },
    };
    const adapter = createGithubRestAdapter({
      fetcher: async (url) => { requests.push(url); return jsonResponse([]); },
    });
    const outcome = adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/cancel-auth',
      signal: controller.signal,
      runtimeServices,
    }).then(() => null, (error: unknown) => error);
    await started;

    try {
      controller.abort(abortReason);
      expect(materializationCancelled).toBe(true);
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(requests).toEqual([]);
    } finally {
      // Also settle the boundary when RED proves the signal never reached it.
      endMaterialization();
      await outcome;
    }
  });

  it('marks a definite provider rejection as a non-effect without assuming the same for server errors', async () => {
    const create = { provider: githubProvider, base: 'main', head: 'feature', title: 'Review' };
    const rejected = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'bound-token' }),
      fetcher: async () => jsonResponse({ message: 'Validation failed' }, { status: 422 }),
    });
    await expect(rejected.createPullRequest(create)).rejects.toMatchObject({ errorCode: 'COMMAND_FAILED', effectNotApplied: true });
    const uncertain = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'bound-token' }),
      fetcher: async () => jsonResponse({ message: 'Server failed' }, { status: 500 }),
    });
    const error = await uncertain.createPullRequest(create).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ effectNotApplied: true });
  });

  it('uses a github.com connected-account token for REST list requests', async () => {
    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token', profileKey: 'github:work' }),
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (!new Headers(init?.headers).get('user-agent')?.trim()) {
          return jsonResponse({ message: 'User-Agent required' }, { status: 403 });
        }
        return jsonResponse([
          {
            number: 1,
            title: 'PR from REST',
            html_url: 'https://github.com/happier-dev/happier/pull/1',
            state: 'open',
            base: { ref: 'main' },
            head: {
              ref: 'feature/rest',
              repo: { full_name: 'happier-dev/happier' },
            },
          },
        ]);
      },
    });
    const controller = new AbortController();

    await expect(adapter.listPullRequests({
      provider: githubProvider,
      base: 'main',
      head: 'feature/rest',
      state: 'open',
      signal: controller.signal,
    })).resolves.toEqual([
      expect.objectContaining({
        number: 1,
        title: 'PR from REST',
        baseBranch: 'main',
        headBranch: 'feature/rest',
        headRepositoryNameWithOwner: 'happier-dev/happier',
      }),
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.github.com/repos/happier-dev/happier/pulls?state=open&base=main&head=feature%2Frest');
    expect(requests[0]?.init?.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      Authorization: ['Bearer', 'redacted-test-token'].join(' '),
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    });
    expect(requests[0]?.init?.signal).toBe(controller.signal);
  });

  it('uses operation-scoped runtime token materialization when constructor token resolver is absent', async () => {
    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const adapter = createGithubRestAdapter({
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse([]);
      },
    });
    const input = {
      provider: githubProvider,
      head: 'feature/runtime-services',
      runtimeServices: {
        resolveScmHostingTokenMaterialization: async (request: Readonly<{
          kind: 'scm_hosting_token';
          providerId: string;
          host: string;
        }>) => ({
          kind: 'available' as const,
          token: [
            'redacted',
            request.kind,
            request.providerId,
            request.host,
          ].join(':'),
          profileKey: 'github:runtime',
        }),
      },
    };

    await expect(adapter.listPullRequests(input)).resolves.toEqual([]);

    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer redacted:scm_hosting_token:scm.github:github.com',
    });
    expect(adapter.getPullRequestAuthProfileKey({ provider: githubProvider })).toBe('github:runtime');
  });

  it('keeps auth profile keys scoped to the provider context that resolved them', async () => {
    const otherProvider: ScmHostingProviderRef = {
      ...githubProvider,
      id: 'scm.github.other',
      nameWithOwner: 'other-owner/other-repo',
    };
    const adapter = createGithubRestAdapter({
      resolveToken: async ({ provider }) => ({
        kind: 'available',
        token: `redacted-${provider.id}`,
        profileKey: provider.id === githubProvider.id ? 'github:work' : 'github:other',
      }),
      fetcher: async () => jsonResponse([]),
    });

    await adapter.listPullRequests({ provider: githubProvider, head: 'feature/one' });
    await adapter.listPullRequests({ provider: otherProvider, head: 'feature/two' });

    expect(adapter.getPullRequestAuthProfileKey({ provider: githubProvider })).toBe('github:work');
    expect(adapter.getPullRequestAuthProfileKey({ provider: otherProvider })).toBe('github:other');
  });

  it('requests Enterprise-scoped authorization and sends it to the Enterprise REST API', async () => {
    const requests: Array<Readonly<{ url: string; init?: RequestInit }>> = [];
    const requestedHosts: string[] = [];
    const adapter = createGithubRestAdapter({
      resolveToken: async ({ host }) => {
        requestedHosts.push(host);
        return { kind: 'available', token: 'redacted-enterprise-token' };
      },
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse([]);
      },
    });

    await expect(adapter.listPullRequests({
      provider: enterpriseProvider,
      head: 'feature/rest',
    })).resolves.toEqual([]);
    expect(requestedHosts).toEqual(['ghe.internal.test']);
    expect(requests[0]?.url).toBe('https://ghe.internal.test/api/v3/repos/happier-dev/happier/pulls?state=open&head=feature%2Frest');
    expect(requests[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer redacted-enterprise-token' });
  });

  it('rejects forged github.com provider base URLs before attaching token material', async () => {
    const requests: unknown[] = [];
    const adapter = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse([]);
      },
    });

    await expect(adapter.listPullRequests({
      provider: {
        ...githubProvider,
        baseUrl: 'https://github.com:8443/path?x=1#fragment',
      },
      head: 'feature/rest',
    })).rejects.toMatchObject({
      errorCode: 'REMOTE_AUTH_REQUIRED',
    });
    expect(requests).toEqual([]);
  });

  it('rejects pull request URL references from a different repository before fetching current-repo data', async () => {
    const requests: unknown[] = [];
    const adapter = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonResponse({});
      },
    });

    await expect(adapter.getPullRequest({
      provider: githubProvider,
      reference: { url: 'https://github.com/other-owner/other-repo/pull/12' },
    })).resolves.toBeNull();
    expect(requests).toEqual([]);
  });

  it('resolves checkout reference metadata without checkout orchestration', async () => {
    const adapter = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token', profileKey: 'github:work' }),
      fetcher: async (url: string) => {
        return jsonResponse({
          number: 12,
          title: 'Checkout metadata only',
          html_url: 'https://github.com/happier-dev/happier/pull/12',
          state: 'open',
          base: { ref: 'main', sha: 'base-sha' },
          head: { ref: 'feature/checkout', sha: 'head-sha' },
        });
      },
    });

    await expect(adapter.resolvePullRequestCheckoutReference({
      provider: githubProvider,
      reference: { number: 12 },
    })).resolves.toMatchObject({
      branch: 'feature/checkout',
      headSha: 'head-sha',
      baseSha: 'base-sha',
      pullRequest: {
        number: 12,
      },
    });
  });

  it('preserves a throttled GitHub 403 retry instant without credential repair', async () => {
    const adapter = createGithubRestAdapter({
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

    // The credential is fine; GitHub exhausted its primary limit. Reporting this
    // as REMOTE_AUTH_REQUIRED tells the owner to reconnect an account that works.
    await expect(adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/rest',
    })).rejects.toMatchObject({
      errorCode: 'REMOTE_RATE_LIMITED',
      retryNotBeforeMs: 1900000000000,
    });
  });

  it('does not turn an unhinted throttle into a forge-provided retry instant', async () => {
    const adapter = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({ message: 'API rate limit exceeded.' }, { status: 429 }),
    });
    const error = await adapter.listPullRequests({ provider: githubProvider }).catch((error: unknown) => error);
    expect(error).toMatchObject({ errorCode: 'REMOTE_RATE_LIMITED' });
    expect(error).not.toMatchObject({ retryNotBeforeMs: expect.any(Number) });
  });

  it('still reports an unthrottled GitHub 403 as remote authentication required', async () => {
    const adapter = createGithubRestAdapter({
      resolveToken: async () => ({ kind: 'available', token: 'redacted-test-token' }),
      fetcher: async () => jsonResponse({ message: 'Resource not accessible by personal access token' }, {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'X-Accepted-GitHub-Permissions': 'pull_requests=read' },
      }),
    });

    await expect(adapter.listPullRequests({
      provider: githubProvider,
      head: 'feature/rest',
    })).rejects.toMatchObject({
      errorCode: 'REMOTE_AUTH_REQUIRED',
    });
  });
});
