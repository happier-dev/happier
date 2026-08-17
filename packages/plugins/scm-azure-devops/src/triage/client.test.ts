import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AZURE_DEVOPS_AUTHORIZATION_HEADER_NAME,
  materializeAzureDevOpsListedAuthorization,
} from './auth.js';
import { createAzureDevOpsApiClient } from './client.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import type {
  AzureDevOpsHttpRequest,
  AzureDevOpsHttpResponse,
  AzureDevOpsOrigin,
} from './types.js';
import projectsPage1 from './fixtures/projects.page1.json';
import repositoryNotFound from './fixtures/error.repositoryNotFound.json';

const NOW_MS = 1_700_000_000_000;
const SIGN_IN_PAGE = '<!DOCTYPE html><html><head><title>Sign In</title></head><body>'
  + '<form id="loginForm" method="post"><input type="hidden" name="ctx" value="REDACTED" />'
  + '</form></body></html>';

function origin(): AzureDevOpsOrigin {
  const result = normalizeAzureDevOpsBaseUrl('https://dev.azure.com/AcmeOrg');
  if (!result.ok) throw new Error('fixture origin must normalize');
  return result.origin;
}

function transportReturning(
  response: AzureDevOpsHttpResponse,
): Readonly<{ transport: (request: AzureDevOpsHttpRequest) => Promise<AzureDevOpsHttpResponse>; calls: AzureDevOpsHttpRequest[] }> {
  const calls: AzureDevOpsHttpRequest[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      return response;
    },
  };
}

function client(response: AzureDevOpsHttpResponse) {
  const boundary = transportReturning(response);
  return {
    calls: boundary.calls,
    client: createAzureDevOpsApiClient({
      origin: origin(),
      authorization: { headers: { authorization: 'Basic REDACTED' } },
      transport: boundary.transport,
      now: () => NOW_MS,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAzureDevOpsApiClient', () => {
  it('sends the pinned URL with the materialized authorization and parses the provider body', async () => {
    const harness = client({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify(projectsPage1),
    });

    const result = await harness.client.request({
      route: { resource: 'projects' },
      query: { $top: 1 },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual(projectsPage1);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.url).toBe('https://dev.azure.com/AcmeOrg/_apis/projects?$top=1&api-version=7.1');
    expect(harness.calls[0]?.headers.authorization).toBe('Basic REDACTED');
    expect(harness.calls[0]?.headers.accept).toBe('application/json');
  });

  it('never waits through a reset window: a 429 is one call, no timer, and a retry fact', async () => {
    vi.useFakeTimers();
    const harness = client({
      status: 429,
      headers: { 'retry-after': '120' },
      bodyText: '',
    });

    const result = await harness.client.request({
      route: { resource: 'projects' },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.class).toBe('rateLimit');
      expect(result.failure.retryNotBeforeMs).toBe(NOW_MS + 120_000);
    }
    expect(harness.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads a 203 sign-in interception as an authorization failure, not a malformed body', async () => {
    const harness = client({
      status: 203,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      bodyText: SIGN_IN_PAGE,
    });

    const result = await harness.client.request({
      route: { resource: 'connectionData' },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.class).toBe('unauthorized');
      expect(result.failure.detail).not.toContain('ctx');
      expect(result.failure.detail).not.toContain('loginForm');
    }
  });

  it('accepts a 203 that actually carries API JSON instead of reading it as an expired credential', async () => {
    const harness = client({
      status: 203,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify(projectsPage1),
    });

    const result = await harness.client.request({
      route: { resource: 'projects' },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual(projectsPage1);
  });

  it('reads a 200 HTML sign-in page as an authorization failure too', async () => {
    const harness = client({
      status: 200,
      headers: { 'Content-Type': 'text/html' },
      bodyText: SIGN_IN_PAGE,
    });

    const result = await harness.client.request({
      route: { resource: 'projects' },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.class).toBe('unauthorized');
  });

  it('keeps a 404 ambiguous between absent and unreadable', async () => {
    const harness = client({
      status: 404,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify(repositoryNotFound),
    });

    const result = await harness.client.request({
      route: {
        resource: 'repositories',
        project: '3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42',
      },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.class).toBe('notFoundOrForbidden');
      expect(result.failure.typeKey).toBe('GitRepositoryNotFoundException');
      expect(result.failure.detail).toContain('TF401019');
    }
  });

  it('reports a redirect rather than following it to another origin', async () => {
    const harness = client({
      status: 302,
      headers: { location: 'https://login.microsoftonline.test/common/oauth2/authorize' },
      bodyText: '',
    });

    const result = await harness.client.request({
      route: { resource: 'projects' },
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.class).toBe('unexpectedRedirect');
    expect(harness.calls).toHaveLength(1);
  });

  it('sends nothing once the invocation signal is already aborted', async () => {
    const harness = client({ status: 200, headers: {}, bodyText: '{}' });
    const controller = new AbortController();
    controller.abort();

    const result = await harness.client.request({
      route: { resource: 'projects' },
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.class).toBe('cancelled');
    expect(harness.calls).toHaveLength(0);
  });

  it('classifies an aborted in-flight request as cancelled rather than a transport fault', async () => {
    const controller = new AbortController();
    const azure = createAzureDevOpsApiClient({
      origin: origin(),
      authorization: { headers: { authorization: 'Basic REDACTED' } },
      transport: async () => {
        controller.abort();
        throw new Error('aborted');
      },
      now: () => NOW_MS,
    });

    const result = await azure.request({ route: { resource: 'projects' }, signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.class).toBe('cancelled');
  });

  it('passes the invocation signal through to the transport boundary', async () => {
    const harness = client({ status: 200, headers: {}, bodyText: '{}' });
    const controller = new AbortController();
    await harness.client.request({ route: { resource: 'projects' }, signal: controller.signal });
    expect(harness.calls[0]?.signal).toBe(controller.signal);
  });
});

describe('materializeAzureDevOpsListedAuthorization', () => {
  const ACCOUNT = {
    service: { pluginId: 'happier.scm.forge.azure-devops', localId: 'azure-devops-account' },
    accountId: 'acct-1',
  } as const;

  it('materializes the exact bound account against the configured request origin', async () => {
    // `CONTRACT.md` §3.1: a configured instance is bound to one exact account, so this seam names
    // it. Reauthorizing "the currently selected binding for the purpose" would let a second
    // account's credential answer for this instance — the multi-account split-brain this
    // exact-account path exists to close.
    const materializeListedAccount = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { authorization: 'Basic REDACTED' },
    }));
    const signal = new AbortController().signal;

    const result = await materializeAzureDevOpsListedAuthorization({
      connectedAccounts: { materializeListedAccount },
      purpose: 'azure-devops-account',
      account: ACCOUNT,
      origin: origin(),
      signal,
    });

    expect(result.ok).toBe(true);
    expect(materializeListedAccount).toHaveBeenCalledTimes(1);
    expect(materializeListedAccount).toHaveBeenCalledWith(
      {
        purpose: 'azure-devops-account',
        account: ACCOUNT,
        materialization: {
          kind: 'httpHeaders',
          origin: 'https://dev.azure.com',
          headerNames: [AZURE_DEVOPS_AUTHORIZATION_HEADER_NAME],
        },
      },
      { signal },
    );
  });

  it('never echoes a materialization rejection into the failure detail', async () => {
    const result = await materializeAzureDevOpsListedAuthorization({
      connectedAccounts: {
        materializeListedAccount: async () => {
          throw new Error('pat=super-secret-token-value');
        },
      },
      purpose: 'azure-devops-account',
      account: ACCOUNT,
      origin: origin(),
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.class).toBe('unauthorized');
      expect(result.failure.detail).not.toContain('super-secret-token-value');
    }
  });

  it('refuses a materialization that produced no header instead of calling Azure unauthenticated', async () => {
    const result = await materializeAzureDevOpsListedAuthorization({
      connectedAccounts: {
        materializeListedAccount: async () => ({ kind: 'httpHeaders' as const, headers: {} }),
      },
      purpose: 'azure-devops-account',
      account: ACCOUNT,
      origin: origin(),
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.class).toBe('unauthorized');
  });

  it('refuses a cancelled invocation before it asks the host for a credential', async () => {
    const controller = new AbortController();
    controller.abort();
    const materializeListedAccount = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { authorization: 'Basic REDACTED' },
    }));

    const result = await materializeAzureDevOpsListedAuthorization({
      connectedAccounts: { materializeListedAccount },
      purpose: 'azure-devops-account',
      account: ACCOUNT,
      origin: origin(),
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(materializeListedAccount).not.toHaveBeenCalled();
  });
});
