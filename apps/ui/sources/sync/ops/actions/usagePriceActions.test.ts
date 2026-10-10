import { afterEach, describe, expect, it } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createUiUsageActionPorts } from './usageActionDeps';
import { captureLazyActionAccountContext } from './actionAccountContext';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(() => { standardCleanup(); retireActiveServerAccountScopeLifetime(); home?.dispose(); home = undefined; });
const catalog = { v: 1, models: { reference: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 100, revision: 'test', fetchStatus: 'ready' } };

describe('Usage model prices through captured UI Account Actions', () => {
    it('reads catalog and refresh provenance without disclosing settings and retires denied or late Account results', async () => {
        let denied = false;
        let retireOnRead = false;
        let refreshed = false;
        const tokens = { input: 1_000_000, output: 500_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_500_000 };
        const cost = { reportedUsd: 7, estimatedUsd: 3, currency: 'USD' };
        const currentCatalog = () => refreshed ? { ...catalog, models: { reference: { inputUsdPerMillion: 6, outputUsdPerMillion: 4 } },
            provenance: { ...catalog.provenance, revision: 'refreshed' } } : catalog;
        home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://price-actions.test', accountId: 'account-a' }],
            route: request => {
                if (request.path === '/v1/account/usage/prices') {
                    if (retireOnRead) retireActiveServerAccountScopeLifetime();
                    return denied ? new Response('denied', { status: 403 }) : Response.json(currentCatalog());
                }
                if (request.path === '/v1/account/usage/prices/refresh') {
                    expect(request.method).toBe('POST');
                    expect(request.body).toEqual({});
                    refreshed = true;
                    return Response.json(currentCatalog());
                }
                if (request.path === '/v2/usage/query') return Response.json({ v: 1,
                    totals: { eventCount: 1, tokens, cost }, priceCatalog: currentCatalog(),
                    contributions: [{ id: 'history', observedAtMs: 150, sessionId: null, turnId: null, agentId: null,
                        modelId: 'reference', machineId: null, projectKey: null, workspaceId: null, source: null, tokens, cost }] });
                return undefined;
            } });
        const focused = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
        const caller = { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id,
            expectedAccountId: 'account-a', authority: 'present_user' as const };
        const credentials = (await TokenStorage.getCredentialsForServerUrl(focused.serverUrl))!;
        const account = captureUiUsageQueryAccountContext(credentials);
        if (!account) throw new Error('Expected admitted Account');
        const actionAccount = await captureLazyActionAccountContext(focused.id);
        const executor = createActionExecutor({ usageActions: createUiUsageActionPorts(actionAccount),
            isActionApprovalRequired: () => false });
        expect(await executor.execute('usage.prices.get', {}, caller)).toMatchObject({ ok: true, result: catalog });
        const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input: { queries: [normalizeUsageQuery({})] } });
        const release = entry.subscribe(() => {}, true);
        const read = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
        try {
            await entry.refresh();
            expect(read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(4);
            expect(await executor.execute('usage.prices.refresh', {}, caller)).toMatchObject({ ok: true,
                result: { provenance: { revision: 'refreshed' } } });
            await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(8);
            expect(read().accounting?.totals.cost).toMatchObject(cost);
        } finally { release(); actionAccount.dispose(); }
        denied = true;
        expect(await executor.execute('usage.prices.get', {}, caller)).toMatchObject({ ok: false, errorCode: 'denied' });
        denied = false; retireOnRead = true;
        const retired = await executor.execute('usage.prices.get', {}, caller);
        expect(retired.ok).toBe(false);
        expect(retired).not.toHaveProperty('result');
        expect(home.requests.every(request => !String(JSON.stringify(request.body)).includes('usageModelPriceOverridesV1'))).toBe(true);
    });
});
