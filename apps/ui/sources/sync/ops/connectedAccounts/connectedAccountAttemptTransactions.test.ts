import { afterEach, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiConnectedAccountAttemptTransactionApi } from './connectedAccountAttemptTransactions';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

afterEach(async () => {
    await homes.reset();
    vi.restoreAllMocks();
});

it.each(['canonical', 'alternate'] as const)('retries a failed pending-attempt read through the %s Home address', async address => {
    const endpointUrl = 'https://attempt-home.example.test';
    const runtimeOrigin = address === 'alternate' ? 'http://127.0.0.1:43210' : endpointUrl;
    const serverId = await homes.addHome({ name: 'Attempt Home', serverUrl: endpointUrl, accountId: 'attempt-account' });
    const account = await captureLazyActionAccountContext(serverId);
    const service = { pluginId: 'acme.accounts', localId: 'work/account' };
    const path = '/v2/connect/connected-account-attempt-transactions/pending';
    const requests: URL[] = [];
    let failed = false;
    // One server exposed at a different transport address. Only network IO is substituted;
    // the Account lifetime, HTTP origin guard and shared transaction API remain real.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe(runtimeOrigin);
        if (url.pathname === path) {
            requests.push(url);
            expect(new Headers(init?.headers).get('Authorization') === `Bearer ${account.credentials.token}`).toBe(true);
            if (!failed) {
                failed = true;
                return Response.json({ error: 'connected_account_attempt_transaction_conflict' }, { status: 409 });
            }
        }
        return homes.request(new URL(url.pathname + url.search, endpointUrl).toString(), init);
    });
    homes.answer(serverId, path, { body: { attempts: [] } });
    const request = createServerFetchAtEndpoint({ endpointUrl, runtimeOrigin, credentials: account.credentials });
    const api = createUiConnectedAccountAttemptTransactionApi({ ...account, request });
    try {
        await expect(api.listPending({ service })).rejects.toMatchObject({ code: 'connected_account_attempt_transaction_conflict' });
        await expect(api.listPending({ service })).resolves.toEqual([]);
        expect(requests.map(url => ({ origin: url.origin, pluginId: url.searchParams.get('pluginId'), localId: url.searchParams.get('localId') })))
            .toEqual(Array.from({ length: 2 }, () => ({ origin: runtimeOrigin, ...service })));
    } finally {
        account.dispose();
    }
});
