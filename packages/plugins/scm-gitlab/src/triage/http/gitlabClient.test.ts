import { describe, expect, it, vi } from 'vitest';

import { normalizeGitlabConfiguredBaseUrl } from '../origin.js';
import {
  authorizeGitlabInvocation,
  buildGitlabApiUrl,
  classifyGitlabFailure,
  requestGitlabJson,
  type GitlabAuthorizedInvocation,
  type GitlabHttpFetcher,
  type GitlabHttpResponse,
} from './gitlabClient.js';
import { createGitlabResponseHeaders } from './gitlabHeaders.js';

const NOW_MS = 1_609_844_100_000;

function originOf(baseUrl: string) {
  const origin = normalizeGitlabConfiguredBaseUrl(baseUrl);
  if (!origin) throw new Error(`unusable base url: ${baseUrl}`);
  return origin;
}

const GITLAB_COM = originOf('https://gitlab.com');

const AUTHORIZED: GitlabAuthorizedInvocation = {
  origin: GITLAB_COM,
  headers: { Authorization: 'Bearer test-only-not-a-real-token', Accept: 'application/json' },
};

function respondWith(input: Readonly<{
  status?: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>): GitlabHttpResponse {
  return {
    status: input.status ?? 200,
    statusText: '',
    headers: createGitlabResponseHeaders(input.headers ?? {}),
    text: async () => input.body ?? '[]',
  };
}

const ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-account' }),
  accountId: 'account-1',
});

describe('authorizeGitlabInvocation', () => {
  it('materializes the exact listed account once, for the declared purpose and configured origin', async () => {
    const materializeListedAccount = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer test-only-not-a-real-token' },
    }));
    const listAccounts = vi.fn(async () => ({ status: 'complete' as const, accounts: [] }));
    const signal = new AbortController().signal;
    const result = await authorizeGitlabInvocation({
      connectedAccounts: { listAccounts, materializeListedAccount },
      purpose: 'gitlab-connected-account',
      account: ACCOUNT,
      origin: GITLAB_COM,
      signal,
    });

    expect(materializeListedAccount).toHaveBeenCalledTimes(1);
    expect(materializeListedAccount).toHaveBeenCalledWith(
      {
        purpose: 'gitlab-connected-account',
        account: ACCOUNT,
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://gitlab.com',
          headerNames: ['authorization'],
        },
      },
      { signal },
    );
    if (result.kind !== 'authorized') throw new Error('expected authorization');
    expect(result.invocation.headers.Authorization).toBe('Bearer test-only-not-a-real-token');
  });

  it('sends the origin the binding named, never a host taken from anywhere else', async () => {
    const materializeListedAccount = vi.fn(async (
      _request: Readonly<{ materialization: Readonly<{ kind: string; origin?: string }> }>,
      _options?: unknown,
    ) => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer test-only-not-a-real-token' },
    }));
    const listAccounts = vi.fn(async () => ({ status: 'complete' as const, accounts: [] }));
    await authorizeGitlabInvocation({
      connectedAccounts: { listAccounts, materializeListedAccount },
      purpose: 'gitlab-connected-account',
      account: ACCOUNT,
      origin: originOf('https://forge.example:8443/Corp/GitLab'),
      signal: new AbortController().signal,
    });
    // The materialization origin is the binding's origin, without the path prefix,
    // because a materialization request is origin-scoped.
    expect(materializeListedAccount.mock.calls[0]?.[0].materialization)
      .toMatchObject({ origin: 'https://forge.example:8443' });
  });

  it('fails typed, without a credential in the detail, when materialization is refused', async () => {
    const result = await authorizeGitlabInvocation({
      connectedAccounts: {
        listAccounts: async () => ({ status: 'complete' as const, accounts: [] }),
        materializeListedAccount: async () => {
          throw new Error('Bearer super-secret-value cannot be materialized for this origin');
        },
      },
      purpose: 'gitlab-connected-account',
      account: ACCOUNT,
      origin: GITLAB_COM,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'authentication',
        code: 'materialization-failed',
        detail: 'The configured GitLab account could not be authorized for this origin.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });
});

describe('buildGitlabApiUrl', () => {
  it('routes under /api/v4 on the configured origin and preserves a configured path prefix', () => {
    expect(buildGitlabApiUrl(GITLAB_COM, '/merge_requests', [['scope', 'created_by_me']]))
      .toBe('https://gitlab.com/api/v4/merge_requests?scope=created_by_me');
    expect(buildGitlabApiUrl(originOf('https://forge.example/Corp/GitLab'), 'issues'))
      .toBe('https://forge.example/Corp/GitLab/api/v4/issues');
  });
});

describe('classifyGitlabFailure', () => {
  it('does not equate 403 with throttling and carries GitLab retry evidence only on a 429', () => {
    const headers = createGitlabResponseHeaders({ 'Retry-After': '30' });
    expect(classifyGitlabFailure(403, headers, NOW_MS))
      .toEqual({ class: 'permission', code: 'forbidden' });
    expect(classifyGitlabFailure(429, headers, NOW_MS)).toEqual({
      class: 'rateLimit',
      code: 'too-many-requests',
      retryNotBeforeMs: NOW_MS + 30_000,
    });
    // GitLab publishes no minimum backoff, so a headerless 429 carries no deadline.
    expect(classifyGitlabFailure(429, createGitlabResponseHeaders({}), NOW_MS))
      .toEqual({ class: 'rateLimit', code: 'too-many-requests' });
    expect(classifyGitlabFailure(401, headers, NOW_MS))
      .toEqual({ class: 'authentication', code: 'unauthorized' });
    expect(classifyGitlabFailure(503, headers, NOW_MS))
      .toEqual({ class: 'transient', code: 'server-error' });
    expect(classifyGitlabFailure(302, headers, NOW_MS))
      .toEqual({ class: 'unsupportedContract', code: 'unexpected-redirect' });
  });
});

describe('requestGitlabJson', () => {
  it('refuses a redirect and never follows one to another host', async () => {
    const fetcher = vi.fn<GitlabHttpFetcher>(async () => respondWith({
      status: 302,
      headers: { Location: 'https://attacker.example/api/v4/merge_requests' },
    }));
    const result = await requestGitlabJson({
      invocation: AUTHORIZED,
      url: 'https://gitlab.com/api/v4/merge_requests',
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    expect(fetcher.mock.calls[0]?.[1].redirect).toBe('error');
    expect(result).toEqual({
      kind: 'failed',
      status: 302,
      failure: { class: 'unsupportedContract', code: 'unexpected-redirect' },
    });
  });

  it('refuses a URL outside the authorized configured origin before issuing a request', async () => {
    const fetcher = vi.fn<GitlabHttpFetcher>(async () => respondWith({}));
    const result = await requestGitlabJson({
      invocation: AUTHORIZED,
      url: 'https://gitlab.com.evil.example/api/v4/merge_requests',
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'origin-mismatch',
        detail: 'A GitLab request may only address the configured binding origin.',
      },
    });
  });

  it('settles a rate limit as one failed result without a second request or any delay', async () => {
    const fetcher = vi.fn<GitlabHttpFetcher>(async () => respondWith({
      status: 429,
      headers: { 'RateLimit-Reset': '1609844400', 'RateLimit-Remaining': '0' },
    }));
    // Fake timers make "no wait" provable rather than merely fast: a client that
    // slept until the reset would never settle while the clock is frozen.
    vi.useFakeTimers();
    try {
      const result = await requestGitlabJson({
        invocation: AUTHORIZED,
        url: 'https://gitlab.com/api/v4/issues',
        fetcher,
        signal: new AbortController().signal,
        nowMs: NOW_MS,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(result).toEqual({
        kind: 'failed',
        status: 429,
        failure: {
          class: 'rateLimit',
          code: 'too-many-requests',
          retryNotBeforeMs: 1_609_844_400_000,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a rate limit without a second request', async () => {
    const fetcher = vi.fn<GitlabHttpFetcher>(async () => respondWith({
      status: 429,
      headers: { 'RateLimit-Reset': '1609844400', 'RateLimit-Remaining': '0' },
    }));
    const result = await requestGitlabJson({
      invocation: AUTHORIZED,
      url: 'https://gitlab.com/api/v4/issues',
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'failed',
      status: 429,
      failure: {
        class: 'rateLimit',
        code: 'too-many-requests',
        retryNotBeforeMs: 1_609_844_400_000,
      },
    });
  });

  it('counts raw response cardinality before any decoding, and passes the signal through', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<GitlabHttpFetcher>(async () => respondWith({
      body: '[{"iid":1},{"not":"an mr"},{"iid":3}]',
    }));
    const result = await requestGitlabJson({
      invocation: AUTHORIZED,
      url: 'https://gitlab.com/api/v4/merge_requests',
      fetcher,
      signal: controller.signal,
      nowMs: NOW_MS,
    });
    expect(fetcher.mock.calls[0]?.[1].signal).toBe(controller.signal);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.response.rawItemCount).toBe(3);
  });

  it('reports an undecodable body as a contract failure rather than an empty success', async () => {
    const result = await requestGitlabJson({
      invocation: AUTHORIZED,
      url: 'https://gitlab.com/api/v4/merge_requests',
      fetcher: async () => respondWith({ body: '<html>maintenance</html>' }),
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'undecodable-body' },
    });
  });
});
