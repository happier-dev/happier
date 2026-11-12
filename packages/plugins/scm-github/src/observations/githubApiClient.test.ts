import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it, vi } from 'vitest';

import { classifyGithubTransportFailure } from '../triage/errors.js';
import { GITHUB_API_VERSION } from './githubProviderContracts.js';

import {
  createGithubListedAccountApiClient,
  createGithubApiClient,
  beginGithubAccountRequestOccurrenceV1,
  getGithubAccountRequestOwnerV1,
  GITHUB_RATE_LIMIT_FALLBACK_MS,
  isGithubRateLimited,
  readGithubApiResponseFacts,
  readGithubRateLimitRetryAfterMs,
  type GithubAccountRequestV1,
} from './githubApiClient.js';

// The classifier reads facts, and both carriers project onto them. Going through
// the `github-api` reader keeps this exercising the real body decode rather than
// hand-built message arrays.
function response(input: Readonly<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}>) {
  return readGithubApiResponseFacts({
    status: input.status,
    headers: input.headers ?? {},
    body: new TextEncoder().encode(JSON.stringify(input.body ?? {})),
  });
}

describe('GitHub API rate-limit classification', () => {
  it('uses the provider minimum retry for a headerless 429 but not an ordinary 403', () => {
    const headerless429 = response({ status: 429 });
    const ordinary403 = response({
      status: 403,
      headers: {
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '61',
      },
      body: { message: 'Resource not accessible by integration' },
    });

    expect(isGithubRateLimited(headerless429)).toBe(true);
    expect(readGithubRateLimitRetryAfterMs(headerless429, 1_000)).toBe(GITHUB_RATE_LIMIT_FALLBACK_MS);
    expect(isGithubRateLimited(ordinary403)).toBe(false);
    expect(readGithubRateLimitRetryAfterMs(ordinary403, 1_000)).toBeNull();
  });

  it('recognizes GitHub’s JSON secondary-limit 403 and preserves reset instructions before the fallback', () => {
    const secondary403 = response({
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
    });
    const primary403 = response({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '61' },
    });

    expect(isGithubRateLimited(secondary403)).toBe(true);
    expect(readGithubRateLimitRetryAfterMs(secondary403, 1_000)).toBe(GITHUB_RATE_LIMIT_FALLBACK_MS);
    expect(readGithubRateLimitRetryAfterMs(primary403, 1_000)).toBe(60_000);
  });

  it('does not borrow a non-exhausted primary reset for a secondary limit', () => {
    expect(readGithubRateLimitRetryAfterMs(response({
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '3601' },
      body: { message: 'You have exceeded a secondary rate limit.' },
    }), 1_000)).toBe(GITHUB_RATE_LIMIT_FALLBACK_MS);
    expect(readGithubRateLimitRetryAfterMs(response({
      status: 429,
      headers: { 'retry-after': 'Thu, 01 Jan 1970 00:02:01 GMT', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '61' },
    }), 1_000)).toBe(120_000);
  });
});

describe('account request ownership', () => {
  const input = { url: 'https://api.github.com/repos/o/r' };
  const ok = { status: 200, headers: {}, body: new TextEncoder().encode('{}') };
  function owner(now: () => number = () => 1_000) {
    return getGithubAccountRequestOwnerV1({ lifetime: {}, accountScope: 'account-a', credentialScope: 'revision-a', now });
  }

  it('shares only simultaneous equivalent reads and isolates caller cancellation', async () => {
    const requestOwner = owner();
    let finish!: (value: typeof ok) => void;
    let sharedSignal!: AbortSignal;
    const transport = vi.fn((_input: GithubAccountRequestV1, signal: AbortSignal) => {
      sharedSignal = signal;
      return new Promise<typeof ok>((resolve) => { finish = resolve; });
    });
    const caller = new AbortController();
    const a = requestOwner.request(input, { signal: caller.signal, transport });
    const b = requestOwner.request(input, { transport });
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await rejected;
    expect(sharedSignal.aborted).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    finish(ok);
    await expect(b).resolves.toBe(ok);
    const c = requestOwner.request(input, { transport });
    expect(transport).toHaveBeenCalledTimes(2);
    finish(ok);
    await c;
  });

  it('admits a joining peer before awaiting its unused transport cleanup', async () => {
    const requestOwner = owner();
    const caller = new AbortController();
    let sharedSignal!: AbortSignal;
    let complete!: (response: typeof ok) => void;
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const a = requestOwner.request(input, { signal: caller.signal, transport: (_input, signal) => {
      sharedSignal = signal;
      return new Promise<typeof ok>((resolve) => { complete = resolve; });
    } });
    const b = requestOwner.request(input, { transport: async () => { throw new Error('Peer must share HTTP'); }, disposeTransport: () => cleanup });
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await rejected;
    const prematurelyAborted = sharedSignal.aborted;
    finishCleanup();
    complete(ok);
    await Promise.allSettled([b]);
    expect(prematurelyAborted).toBe(false);
    await expect(b).resolves.toBe(ok);
  });

  it('does not inspect successful response bodies to update rate-limit state', async () => {
    let bodyReads = 0;
    const binary = {
      status: 200, headers: {},
      get body() { bodyReads += 1; return new Uint8Array([0, 255]); },
    };
    await owner().request(input, { transport: async () => binary });
    expect(bodyReads).toBe(0);
  });

  it('aborts transport when all consumers leave and does not retain a rejected read', async () => {
    const requestOwner = owner();
    let sharedSignal!: AbortSignal;
    const transport = vi.fn((_input: GithubAccountRequestV1, signal: AbortSignal) => {
      sharedSignal = signal;
      return new Promise<typeof ok>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    });
    const caller = new AbortController();
    const pending = requestOwner.request(input, { signal: caller.signal, transport });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await rejected;
    expect(sharedSignal.aborted).toBe(true);
    await expect(requestOwner.request(input, { transport: async () => ok })).resolves.toBe(ok);
  });

  it('releases rejected reads so fresh demand can recover from a transport failure', async () => {
    const requestOwner = owner();
    await expect(requestOwner.request(input, { transport: async () => { throw new Error('Network unavailable'); } })).rejects.toThrow('Network unavailable');
    await expect(requestOwner.request(input, { transport: async () => ok })).resolves.toBe(ok);
  });

  it('partitions representations, validators, pages, read bodies and writes', async () => {
    const requestOwner = owner();
    const transport = vi.fn(async () => ok);
    await Promise.all([
      requestOwner.request(input, { transport }),
      requestOwner.request({ ...input, headers: { 'If-None-Match': 'a' } }, { transport }),
      requestOwner.request({ ...input, headers: { Accept: 'text/plain' } }, { transport }),
      requestOwner.request({ url: `${input.url}?page=2` }, { transport }),
      ...[1, 2, 1].map((n) => requestOwner.request({ url: 'https://api.github.com/graphql', method: 'POST', readOnlyGraphql: true, body: new TextEncoder().encode(JSON.stringify({ query: 'query Node($id: ID!) { node(id: $id) { id } }', variables: { id: String(n) } })) }, { transport })),
      ...[1, 2].map(() => requestOwner.request({ ...input, method: 'POST' }, { transport })),
      ...[1, 2].map(() => requestOwner.request({ ...input, method: 'POST', readOnlyGraphql: true }, { transport })),
    ]);
    expect(transport).toHaveBeenCalledTimes(10);
  });

  it('retains the maximum backoff despite an older success, sends zero HTTP while parked, and resumes only on demand', async () => {
    let now = 1_000;
    const requestOwner = owner(() => now);
    let finish!: (value: typeof ok) => void;
    let finishShorter!: (value: typeof ok) => void;
    const older = requestOwner.request({ url: `${input.url}/older` }, { transport: () => new Promise<typeof ok>((resolve) => { finish = resolve; }) });
    const shorter = requestOwner.request({ url: `${input.url}/shorter` }, { transport: () => new Promise<typeof ok>((resolve) => { finishShorter = resolve; }) });
    const transport = vi.fn(async () => ({ ...ok, status: 403, headers: { 'retry-after': '120' } }));
    await requestOwner.request(input, { transport });
    finishShorter({ ...ok, status: 429, headers: { 'retry-after': '30' } });
    await shorter;
    finish(ok);
    await older;
    const parked = await requestOwner.request({ ...input, method: 'POST' }, { transport });
    expect(readGithubRateLimitRetryAfterMs(readGithubApiResponseFacts(parked), now)).toBe(120_000);
    for (const url of ['https://api.github.com/search/issues?q=test', 'https://api.github.com/graphql']) {
      expect((await requestOwner.request({ url }, { transport })).status).toBe(429);
    }
    expect(transport).toHaveBeenCalledTimes(1);
    now = 121_000;
    await requestOwner.request(input, { transport: async () => ok });
  });

  it.each(['core', 'search', 'graphql'].flatMap(resource => [true, false].map(reported => ({ resource, reported }))))(
    'parks only the exhausted $resource resource (header=$reported) and leaves other resources usable', async ({ resource, reported }) => {
    let now = 1_000;
    let bodyReads = 0;
    const lifetime = {};
    const requestOwner = getGithubAccountRequestOwnerV1({ lifetime, accountScope: 'a', credentialScope: 'revision', now: () => now });
    const otherAccount = getGithubAccountRequestOwnerV1({ lifetime, accountScope: 'b', credentialScope: 'revision', now: () => now });
    const exhausted = {
      status: 200,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '61', ...(reported ? { 'x-ratelimit-resource': resource } : {}) },
      get body() { bodyReads += 1; return new Uint8Array([0, 255]); },
    };
    const transport = vi.fn(async (_request: GithubAccountRequestV1) => ok).mockResolvedValueOnce(exhausted);
    const peerTransport = vi.fn(async () => ok);

    const resourceInput = (kind: string, suffix = '') => ({ url: kind === 'search'
      ? `https://api.github.com/search/issues?q=repo:o/r${suffix}`
      : kind === 'graphql' ? 'https://api.github.com/graphql' : `${input.url}${suffix}` });
    await expect(requestOwner.request(resourceInput(resource), { transport })).resolves.toBe(exhausted);
    expect(bodyReads).toBe(0);
    const next = resourceInput(resource, '/another-endpoint');
    const parked = await requestOwner.request(next, { transport });
    expect(parked.status).toBe(429);
    expect(parked.headers['retry-after']).toBe('60');
    expect(transport).toHaveBeenCalledTimes(1);
    for (const other of ['core', 'search', 'graphql'].filter((kind) => kind !== resource)) {
      await expect(requestOwner.request(resourceInput(other), { transport: peerTransport })).resolves.toBe(ok);
    }
    expect(peerTransport).toHaveBeenCalledTimes(2);
    await expect(otherAccount.request(next, { transport: peerTransport })).resolves.toBe(ok);
    expect(peerTransport).toHaveBeenCalledTimes(3);

    now = 60_999;
    expect((await requestOwner.request(next, { transport })).status).toBe(429);
    expect(transport).toHaveBeenCalledTimes(1);
    now = 61_000;
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(requestOwner.request(next, { transport })).resolves.toBe(ok);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[0]).toEqual(next);
    expect(bodyReads).toBe(0);
  });

  it.each([403, 429])('isolates a primary %s rejection to search while secondary throttling remains global', async (status) => {
    const requestOwner = owner();
    const search = { url: 'https://api.github.com/search/issues?q=test' };
    const transport = vi.fn(async () => ok);
    await requestOwner.request(search, { transport: async () => ({ ...ok, status,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '61', 'x-ratelimit-resource': 'search' },
    }) });
    expect((await requestOwner.request(search, { transport })).status).toBe(429);
    expect(transport).toHaveBeenCalledTimes(0);
    await expect(requestOwner.request(input, { transport })).resolves.toBe(ok);
    await expect(requestOwner.request({ url: 'https://api.github.com/graphql' }, { transport })).resolves.toBe(ok);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('finishes an admitted page walk with captured credentials across refresh while new admissions use the new owner', async () => {
    const retire = beginGithubAccountRequestOccurrenceV1();
    const caller = new AbortController();
    let complete!: (response: typeof ok) => void;
    type HttpBoundaryRequest = Parameters<Parameters<typeof createPluginHttpFixture>[0]['request']>[0];
    const attempted: HttpBoundaryRequest[] = [];
    const request = vi.fn(async (value: HttpBoundaryRequest) => {
      attempted.push(value);
      return attempted.length === 1 ? new Promise<typeof ok>((resolve) => { complete = resolve; }) : ok;
    });
    const makeContext = (credential: string, signal: AbortSignal) => ({
      signal,
      plugin: { id: ACCOUNT_REF.service.pluginId },
      services: {
        connectedAccounts: {
          materializeListedAccount: async () => ({ kind: 'httpHeaders', headers: { authorization: credential } }),
        },
        http: createPluginHttpFixture({ request }),
      },
    }) as unknown as Parameters<typeof createGithubListedAccountApiClient>[0];
    try {
      const admitted = await createGithubListedAccountApiClient(makeContext('Bearer old', caller.signal), ACCOUNT_REF);
      const firstPage = admitted.request({ url: `${input.url}?page=1` });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      const refreshed = await createGithubListedAccountApiClient(makeContext('Bearer new', new AbortController().signal), ACCOUNT_REF);
      expect(refreshed.immutableDefinitionLifetime).not.toBe(admitted.immutableDefinitionLifetime);
      complete(ok);
      await expect(firstPage).resolves.toMatchObject({ status: 200 });
      await expect(admitted.request({ url: `${input.url}?page=2` })).resolves.toMatchObject({ status: 200 });
      await expect(refreshed.request({ url: `${input.url}?page=1` })).resolves.toMatchObject({ status: 200 });
      expect(attempted.map((value) => value.headers?.Authorization)).toEqual(['Bearer old', 'Bearer old', 'Bearer new']);
      caller.abort();
      await expect(admitted.request(input)).rejects.toMatchObject({ name: 'AbortError' });
      retire();
      await expect(refreshed.request(input)).rejects.toMatchObject({ name: 'AbortError' });
      expect(request).toHaveBeenCalledTimes(3);
    } finally { retire(); }
  });

  it('retracts a refreshed old owner\'s late response after explicit disposal even when HTTP ignores abort', async () => {
    const lifetime = {};
    const requestOwner = getGithubAccountRequestOwnerV1({ lifetime, accountScope: 'a', credentialScope: 'old' });
    let complete!: (response: typeof ok) => void;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const pending = requestOwner.request(input, {
      transport: () => new Promise<typeof ok>((resolve) => { complete = resolve; }),
      disposeTransport: async () => { release(); },
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    getGithubAccountRequestOwnerV1({ lifetime, accountScope: 'a', credentialScope: 'new' });
    requestOwner.dispose();
    complete(ok);
    await rejected;
    await released;
    await expect(requestOwner.request(input, { transport: async () => ok })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('shares admitted account state across foreground and Channels factories and releases it on occurrence cleanup', async () => {
    const retire = beginGithubAccountRequestOccurrenceV1();
    let complete!: (response: typeof ok) => void;
    const request = vi.fn(() => new Promise<typeof ok>((resolve) => { complete = resolve; }));
    const makeContext = () => ({
      signal: new AbortController().signal,
      plugin: { id: ACCOUNT_REF.service.pluginId },
      services: {
        connectedAccounts: {
          materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer test' } }),
          materializeListedAccount: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer test' } }),
        },
        http: createPluginHttpFixture({ request: request }),
      },
    }) as unknown as Parameters<typeof createGithubApiClient>[0];
    try {
      const foreground = await createGithubApiClient(makeContext(), ACCOUNT_REF);
      const channels = await createGithubListedAccountApiClient(makeContext(), ACCOUNT_REF);
      const a = foreground.request(input);
      const b = channels.request(input);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      complete(ok);
      await Promise.all([a, b]);
      retire();
      await expect(channels.request(input)).rejects.toMatchObject({ name: 'AbortError' });
    } finally { retire(); }
  });
});

const ACCOUNT_REF: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.scm.forge.github', localId: 'github-account' }),
  accountId: 'a1',
});

describe('GitHub API URL admission', () => {
  it('sends the credential only to an admissible github.com API URL', async () => {
    const attempted: Array<Readonly<{
      url: string;
      method?: string;
      headers?: Readonly<Record<string, string>>;
    }>> = [];
    const context = {
      signal: new AbortController().signal,
      plugin: { id: 'happier.scm.forge.github' },
      services: {
        connectedAccounts: {
          async materializeListedAccount() {
            return { kind: 'httpHeaders' as const, headers: { authorization: 'Bearer t' } };
          },
        },
        http: createPluginHttpFixture({ request: async (input: Readonly<{
            url: string;
            method?: string;
            headers?: Readonly<Record<string, string>>;
          }>) => {
            attempted.push(input);
            // GitHub rejects requests without an application User-Agent, including
            // authenticated reads. The pinned HTTP transport adds no implicit one.
            const userAgent = Object.entries(input.headers ?? {}).find(([key]) => key.toLowerCase() === 'user-agent')?.[1];
            return { status: userAgent?.trim() ? 200 : 403, headers: {}, body: new TextEncoder().encode('{}') };
        } }),
      },
    } as unknown as Parameters<typeof createGithubListedAccountApiClient>[0];

    const client = await createGithubListedAccountApiClient(
      context,
      ACCOUNT_REF,
    );

    await expect(client.request({
      url: 'https://api.github.com/repos/o/r',
      headers: {
        accept: 'text/plain',
        authorization: 'Bearer caller-override',
        'user-agent': '',
        'x-github-api-version': 'caller-override',
        'Content-Type': 'application/json',
      },
    })).resolves.toMatchObject({ status: 200 });
    for (const refused of [
      'https://api.github.com.evil.test/repos/o/r',
      'http://api.github.com/repos/o/r',
      'https://user:pass@api.github.com/repos/o/r',
      // A fragment is refused too: only the part before it is ever sent, so following it
      // would issue a request the source did not describe.
      'https://api.github.com/repos/o/r#x',
      'not-a-url',
    ]) {
      await expect(client.request({ url: refused }), refused).rejects.toMatchObject({
        code: 'github_api_origin_invalid',
      });
    }
    expect(attempted).toEqual([expect.objectContaining({
      url: 'https://api.github.com/repos/o/r',
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer t',
        'User-Agent': 'happier.scm.forge.github',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'Content-Type': 'application/json',
      },
    })]);
  });
});

describe('GitHub listed-account authorization', () => {
  it('publishes an admitted response without admitting it again after the HTTP body completes', async () => {
    let revoked = false;
    let admissions = 0;
    const http = createPluginHttpFixture({ request: async () => {
      revoked = true;
      return { status: 200, headers: {}, body: new TextEncoder().encode('{}') };
    } });
    const context = {
      signal: new AbortController().signal,
      plugin: { id: ACCOUNT_REF.service.pluginId },
      services: {
        connectedAccounts: { materializeListedAccount: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer synthetic' } }) },
        http: { ...http, prepareRead: async (...args: Parameters<typeof http.prepareRead>) => {
          admissions += 1;
          if (revoked) throw Object.assign(new Error('New request refused'), { code: 'permission_denied' });
          return http.prepareRead(...args);
        } },
      },
    } as unknown as Parameters<typeof createGithubListedAccountApiClient>[0];
    const client = await createGithubListedAccountApiClient(context, ACCOUNT_REF);
    const result = await Promise.allSettled([client.request({ url: 'https://api.github.com/repos/o/r' })]);
    expect(result).toMatchObject([{ status: 'fulfilled', value: { status: 200 } }]);
    expect(admissions).toBe(1);
    await expect(client.request({ url: 'https://api.github.com/repos/o/r' })).rejects.toMatchObject({ code: 'permission_denied' });
  });

  function contextWithMaterializer(
    materializeListedAccount: () => Promise<unknown>,
    signal: AbortSignal = new AbortController().signal,
  ): Parameters<typeof createGithubListedAccountApiClient>[0] {
    return {
      signal,
      plugin: { id: 'happier.scm.forge.github' },
      services: {
        connectedAccounts: { materializeListedAccount },
        http: {
          async request() {
            throw new Error('no request should be attempted without authorization');
          },
        },
      },
    } as unknown as Parameters<typeof createGithubListedAccountApiClient>[0];
  }

  it('preserves a typed host materialization refusal without echoing its private message', async () => {
    // The user fixes a revoked or unauthorized account by reconnecting and pressing
    // Refresh, and `refresh/refreshEligibility.ts` exempts `authentication` from the
    // aggregate backoff for exactly that reason. Classifying it `unsupportedContract`
    // told the reader this source cannot support the contract instead.
    const caught = await createGithubListedAccountApiClient(
      contextWithMaterializer(() => Promise.reject(
        Object.assign(new Error('account revoked'), { code: 'connected_account_revoked' }),
      )),
      ACCOUNT_REF,
    ).catch((error: unknown) => error);

    expect(classifyGithubTransportFailure(caught)).toEqual({
      class: 'authentication',
      code: 'connected_account_revoked',
    });
  });

  it('reports an uncoded host rejection as authentication too, not as a provider blip', async () => {
    const caught = await createGithubListedAccountApiClient(
      contextWithMaterializer(() => Promise.reject(new Error('nope'))),
      ACCOUNT_REF,
    ).catch((error: unknown) => error);

    expect(classifyGithubTransportFailure(caught)).toEqual({
      class: 'authentication',
      code: 'github_credential_unavailable',
    });
  });

  it('keeps a cancelled materialization transient rather than turning it into a credential problem', async () => {
    const controller = new AbortController();
    controller.abort();
    const caught = await createGithubListedAccountApiClient(
      contextWithMaterializer(
        () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        controller.signal,
      ),
      ACCOUNT_REF,
    ).catch((error: unknown) => error);

    expect(classifyGithubTransportFailure(caught)).toEqual({
      class: 'transient',
      code: 'github_request_cancelled',
    });
  });
});
