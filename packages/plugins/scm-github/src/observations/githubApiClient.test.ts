import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it } from 'vitest';

import { classifyGithubTransportFailure } from '../triage/errors.js';
import { GITHUB_API_VERSION } from './githubProviderContracts.js';

import {
  createGithubListedAccountApiClient,
  GITHUB_RATE_LIMIT_FALLBACK_MS,
  isGithubRateLimited,
  readGithubApiResponseFacts,
  readGithubRateLimitRetryAfterMs,
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
        http: {
          async request(input: Readonly<{
            url: string;
            method?: string;
            headers?: Readonly<Record<string, string>>;
          }>) {
            attempted.push(input);
            // GitHub rejects requests without an application User-Agent, including
            // authenticated reads. The pinned HTTP transport adds no implicit one.
            const userAgent = Object.entries(input.headers ?? {}).find(([key]) => key.toLowerCase() === 'user-agent')?.[1];
            return { status: userAgent?.trim() ? 200 : 403, headers: {}, body: new TextEncoder().encode('{}') };
          },
        },
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

  it('reports a host materialization refusal as authentication, and never echoes the host’s own code', async () => {
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
      code: 'github_credential_unavailable',
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
