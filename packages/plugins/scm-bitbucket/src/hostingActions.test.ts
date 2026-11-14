import { afterEach, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { BITBUCKET_PLUGIN } from './manifest.js';
import { activate as activateAccount } from './accountRuntime.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID } from './triage/source/descriptor.js';

afterEach(() => vi.restoreAllMocks());

it('runs declared list and create operations with admitted Basic credentials through the existing adapter', async () => {
  const provider = { id: `${BITBUCKET_PLUGIN.manifest.id}/bitbucket`, kind: 'bitbucket', displayName: 'Bitbucket',
    baseUrl: 'https://bitbucket.org', nameWithOwner: 'team/project' };
  const account = { service: { pluginId: BITBUCKET_PLUGIN.manifest.id, localId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID }, accountId: 'shared-source' };
  const authorization = `Basic ${btoa('member@example.test:shared-token')}`;
  const unavailable = (): never => { throw new Error('Unexpected host service'); };
  // The SDK test host is the plugin's capability boundary. Activation, schema
  // admission, operation routing and provider projection below it remain real.
  const connectedAccounts: ConnectedAccountsService = {
    async getBinding(purpose) { return { purpose, account, service: account.service,
      target: { kind: 'account', displayName: 'Shared source' } }; },
    async materialize(purpose, request, options) {
      expect(purpose).toBe(BITBUCKET_CONNECTED_ACCOUNT_PURPOSE);
      expect(options?.expectedAccount).toEqual(account);
      expect(request).toEqual({ kind: 'httpHeaders', origin: 'https://bitbucket.org', headerNames: ['authorization'] });
      return { kind: 'httpHeaders', headers: { Authorization: authorization } };
    },
    listAccounts: unavailable, materializeListedAccount: unavailable, requestSelection: unavailable, watch: unavailable,
  };
  const requests: Array<{ method: string; authorization: string | null }> = [];
  const pullRequest = { id: 42, title: 'Shared credential', state: 'OPEN',
    links: { html: { href: 'https://bitbucket.org/team/project/pull-requests/42' } },
    source: { branch: { name: 'feature' }, repository: { full_name: 'team/project' } },
    destination: { branch: { name: 'main' }, repository: { full_name: 'team/project' } } };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    requests.push({ method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
    return Response.json(init?.method === 'POST' ? pullRequest : { values: [pullRequest] }, { status: init?.method === 'POST' ? 201 : 200 });
  });
  const kit = await createPluginTestkit({ manifest: BITBUCKET_PLUGIN.manifest,
    module: { activate: BITBUCKET_PLUGIN.activate, activateAccount }, services: { connectedAccounts } });
  try {
    const operations = BITBUCKET_PLUGIN.manifest.contributes.scmHostingProviders[0]?.operationActions;
    expect(operations).toMatchObject({ listPullRequests: expect.any(String), createPullRequest: expect.any(String) });
    if (!operations?.listPullRequests || !operations.createPullRequest) throw new Error('Missing declared hosting operations');
    expect(await kit.invokeAction(operations.listPullRequests, { provider, head: 'feature' })).toMatchObject([{ number: 42 }]);
    const created = await kit.invokeAction(operations.createPullRequest, { provider, head: 'feature', base: 'main', title: 'Shared credential' });
    expect(created).toMatchObject({ number: 42 });
    expect(JSON.stringify(created)).not.toContain('shared-token');
    expect(requests).toEqual([{ method: 'GET', authorization }, { method: 'POST', authorization }]);
  } finally { await kit.dispose(); }
});
