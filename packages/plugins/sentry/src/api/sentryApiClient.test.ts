import { describe, expect, it, vi } from 'vitest';

import issuesListPage1 from '../fixtures/issuesListPage1.json' with { type: 'json' };
import issuesListRateLimited from '../fixtures/issuesListRateLimited.json' with { type: 'json' };

import { SENTRY_CONNECTED_ACCOUNT_PURPOSE } from '../sentryContracts.js';
import { createSentryApiClient } from './sentryApiClient.js';

const CLOUD = Object.freeze({
  kind: 'cloud' as const,
  region: 'us' as const,
  origin: 'https://us.sentry.io',
});

const ACCOUNT = Object.freeze({
  service: { pluginId: 'happier.sentry', localId: 'sentry-account' },
  accountId: 'account-1',
});

function createContext(overrides: Readonly<{
  materialize?: ReturnType<typeof vi.fn>;
  request?: ReturnType<typeof vi.fn>;
  signal?: AbortSignal;
}> = {}) {
  const materialize = overrides.materialize ?? vi.fn(async () => ({
    kind: 'httpHeaders' as const,
    headers: { Authorization: 'Bearer test-token-value' },
  }));
  const materializeListedAccount = materialize;
  const request = overrides.request ?? vi.fn(async () => ({
    status: issuesListPage1.status,
    finalUrl: issuesListPage1.request.url,
    headers: issuesListPage1.headers,
    body: new TextEncoder().encode(JSON.stringify(issuesListPage1.body)),
  }));
  return {
    context: {
      signal: overrides.signal ?? new AbortController().signal,
      services: {
        connectedAccounts: { materializeListedAccount },
        http: { request },
      },
    },
    materialize,
    request,
  };
}

async function createClient(overrides: Parameters<typeof createContext>[0] = {}) {
  const harness = createContext(overrides);
  const client = await createSentryApiClient({
    // The client consumes only the two host services it needs.
    signal: harness.context.signal,
    services: harness.context.services,
  } as never, {
    account: ACCOUNT as never,
    deployment: CLOUD,
    nowMs: () => 1_786_000_000_000,
  });
  return { ...harness, client };
}

describe('createSentryApiClient', () => {
  it('materializes the exact listed account once, as http headers, for the configured origin', async () => {
    const { client, materialize, request } = await createClient();

    await client.request({ url: issuesListPage1.request.url, operation: 'issuesList' });
    await client.request({ url: issuesListPage1.request.url, operation: 'issuesList' });

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0]?.[0]).toEqual({
      purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      account: ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://us.sentry.io',
        headerNames: ['authorization'],
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('sends the materialized authorization on a GET that never follows a redirect', async () => {
    const { client, request } = await createClient();

    await client.request({ url: issuesListPage1.request.url, operation: 'issuesList' });

    const sent = request.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.method).toBe('GET');
    expect(sent.redirect).toBe('error');
    expect((sent.headers as Record<string, string>).Authorization).toBe('Bearer test-token-value');
    expect((sent.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('returns the transport response verbatim for the parsers that own it', async () => {
    const { client } = await createClient();

    const outcome = await client.request({
      url: issuesListPage1.request.url,
      operation: 'issuesList',
    });

    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(200);
    expect(outcome.response.headers).toEqual(issuesListPage1.headers);
    expect(JSON.parse(outcome.response.bodyText)).toEqual(issuesListPage1.body);
  });

  it('refuses to send credentials to any origin other than the configured deployment', async () => {
    const { client, request } = await createClient();

    for (const url of [
      'https://de.sentry.io/api/0/organizations/7701/issues/',
      'https://sentry.io/api/0/organizations/7701/issues/',
      'https://us.sentry.io.evil.example/api/0/organizations/7701/issues/',
      'http://us.sentry.io/api/0/organizations/7701/issues/',
      'not-a-url',
    ]) {
      const outcome = await client.request({ url, operation: 'issuesList' });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') continue;
      expect(outcome.failure.code).toBe('sentry-invoked-origin-mismatch');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('builds no request carrying an llmFormat parameter', async () => {
    const { client, request } = await createClient();

    const outcome = await client.request({
      url: 'https://us.sentry.io/api/0/organizations/7701/issues/5501001/?llmFormat=markdown',
      operation: 'issue',
    });

    expect(outcome.kind).toBe('failed');
    expect(request).not.toHaveBeenCalled();
  });

  it('classifies a 429 into the typed rate-limit failure with the response deadline', async () => {
    const { client } = await createClient({
      request: vi.fn(async () => ({
        status: issuesListRateLimited.status,
        finalUrl: issuesListRateLimited.request.url,
        headers: issuesListRateLimited.headers,
        body: new TextEncoder().encode(JSON.stringify(issuesListRateLimited.body)),
      })),
    });

    const outcome = await client.request({
      url: issuesListPage1.request.url,
      operation: 'issuesList',
    });

    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response.status).toBe(429);
  });

  it('reports a transport throw as a transient failure without echoing its message', async () => {
    const { client } = await createClient({
      request: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:443');
      }),
    });

    const outcome = await client.request({
      url: issuesListPage1.request.url,
      operation: 'issuesList',
    });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'sentry-upstream-unavailable' },
    });
    expect(JSON.stringify(outcome)).not.toContain('ECONNREFUSED');
  });

  it('reports cancellation distinctly from an upstream outage', async () => {
    const controller = new AbortController();
    const { client } = await createClient({ signal: controller.signal });
    controller.abort();

    const outcome = await client.request({
      url: issuesListPage1.request.url,
      operation: 'issuesList',
    });

    expect(outcome).toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'sentry-cancelled' },
    });
  });

  it('fails closed when the account cannot materialize an authorization header', async () => {
    const { client, request } = await createClient({
      materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: {} })),
    });

    const outcome = await client.request({
      url: issuesListPage1.request.url,
      operation: 'issuesList',
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.failure.class).toBe('authentication');
    expect(request).not.toHaveBeenCalled();
  });

  it('never returns the token, a token prefix or a header dump in any outcome', async () => {
    const { client } = await createClient();

    const outcome = await client.request({
      url: issuesListPage1.request.url,
      operation: 'issuesList',
    });

    expect(JSON.stringify(outcome)).not.toContain('test-token-value');
    expect(JSON.stringify(outcome)).not.toContain('Bearer');
  });
});
