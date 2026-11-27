import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });
const catalog = { v: 1, models: { reference: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 100, revision: 'test', fetchStatus: 'ready' } };

describe('Usage model prices through captured UI Account Actions', () => {
    it('shares price acquisition across independent Action callers without sharing their cancellation', async () => {
        const held = createDeferred<void>();
        home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://price-sharing.test', accountId: 'account-a' }],
            route: async request => {
                if (request.path !== '/v1/account/usage/prices') return undefined;
                await held.promise;
                return Response.json(catalog);
            } });
        const focused = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
        const caller = { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id,
            expectedAccountId: 'account-a', authority: 'present_user' as const };
        const executor = createDefaultActionExecutor();
        const abort = new AbortController();
        const departed = executor.execute('usage.prices.get', {}, { ...caller, signal: abort.signal });
        void departed.catch(() => {});
        const live = executor.execute('usage.prices.get', {}, caller);
        const requests = () => home!.requests.filter(request => request.path === '/v1/account/usage/prices');
        try {
            await vi.waitFor(() => expect(requests().length).toBeGreaterThan(0));
            await flushHookEffects({ cycles: 20 });
            expect(requests()).toHaveLength(1);
            abort.abort();
            held.resolve();
            await expect(departed).rejects.toMatchObject({ name: 'AbortError' });
            expect(await live).toMatchObject({ ok: true, result: catalog });
            expect(await executor.execute('usage.prices.get', {}, caller)).toMatchObject({ ok: true, result: catalog });
            expect(requests()).toHaveLength(2);
        } finally { held.resolve(); await Promise.allSettled([departed, live]); }
    });

    it('reads catalog and refresh provenance without disclosing settings and retires denied or late Account results', async () => {
        let denied = false;
        let refusal: 'credential_scope_denied' | 'present_user_required' | undefined;
        let retireOnRead = false;
        let refreshed = false;
        const tokens = { input: 1_000_000, output: 500_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_500_000 };
        const cost = { reportedUsd: 7, estimatedUsd: 3, currency: 'USD' };
        const currentCatalog = () => refreshed ? { ...catalog, models: { reference: { inputUsdPerMillion: 6, outputUsdPerMillion: 4 } },
            provenance: { ...catalog.provenance, revision: 'refreshed' } } : catalog;
        home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://price-actions.test', accountId: 'account-a' }],
            route: async request => {
                if (request.path === '/v1/account/usage/prices') {
                    // The captured Action Account retires with its Home credential (af4706f44d).
                    if (retireOnRead) await TokenStorage.removeCredentialsForServerUrl('https://price-actions.test', { serverId: home!.homes.a!.id });
                    if (refusal) return Response.json({ error: refusal }, { status: 403 });
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
        const executor = createDefaultActionExecutor();
        expect(await executor.execute('usage.prices.get', {}, caller)).toMatchObject({ ok: true, result: catalog });
        const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({})] }) });
        const release = entry.subscribe(() => {}, true);
        const read = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
        try {
            await entry.refresh();
            expect(read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(4);
            expect(await executor.execute('usage.prices.refresh', {}, caller)).toMatchObject({ ok: true,
                result: { provenance: { revision: 'refreshed' } } });
            await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(8);
            expect(read().accounting?.totals.cost).toMatchObject(cost);
            denied = true;
            expect(await executor.execute('usage.prices.get', {}, caller)).toMatchObject({ ok: false, errorCode: 'denied' });
            denied = false;
            refusal = 'credential_scope_denied';
            expect(await executor.execute('usage.prices.get', {}, caller))
                .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
            refusal = 'present_user_required';
            expect(await executor.execute('usage.prices.get', {}, caller))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            refusal = undefined; retireOnRead = true;
            expect(await executor.execute('usage.prices.get', {}, caller))
                .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(home.requests.every(request => !String(JSON.stringify(request.body)).includes('usageModelPriceOverridesV1'))).toBe(true);
        } finally { release(); }
    });
});
