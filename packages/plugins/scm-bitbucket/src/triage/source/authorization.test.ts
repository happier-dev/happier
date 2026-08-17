import type {
  ConnectedAccountMaterialization,
  ConnectedAccountsService,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { describe, expect, it } from 'vitest';

import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import { createAuthorizedBitbucketClient } from './authorization.js';
import { accountRef, createHttpStub } from './testSupport.js';

function runtime(materialization: ConnectedAccountMaterialization, http: HttpService) {
  const connectedAccounts = {
    async materializeListedAccount() {
      return materialization;
    },
  } as unknown as ConnectedAccountsService;
  return { connectedAccounts, http, now: () => 1_760_000_000_000 };
}

describe('createAuthorizedBitbucketClient', () => {
  it('refuses a materialization that carries no usable authorization, before any request', async () => {
    // Building the client anyway would spend the user's read as an anonymous Bitbucket call
    // and then report the resulting `401`/`404` as though this account had been refused.
    const { http, requests } = createHttpStub(() => undefined);

    for (const headers of [{}, { Accept: 'application/json' }, { authorization: '  ' }]) {
      const outcome = await createAuthorizedBitbucketClient(
        runtime({ kind: 'httpHeaders', headers }, http),
        { purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: accountRef('account-1') },
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure).toEqual({
        class: 'authentication',
        code: 'account-authorization-unavailable',
      });
    }
    expect(requests).toHaveLength(0);
  });

  it('refuses a materialization of another kind', async () => {
    const { http } = createHttpStub(() => undefined);
    const outcome = await createAuthorizedBitbucketClient(
      runtime({ kind: 'environment', env: { BITBUCKET_TOKEN: 't' } }, http),
      { purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: accountRef('account-1') },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('account-materialization-kind');
  });

  it('sends the materialized authorization on the authorized client', async () => {
    const { http, requests } = createHttpStub(() => ({ status: 200, body: { values: [] } }));
    const outcome = await createAuthorizedBitbucketClient(
      runtime({ kind: 'httpHeaders', headers: { Authorization: 'Basic secret' } }, http),
      { purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: accountRef('account-1') },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    await outcome.client.requestJson({ url: 'https://api.bitbucket.org/2.0/workspaces' });
    expect(requests[0]?.headers.Authorization).toBe('Basic secret');
  });
});
