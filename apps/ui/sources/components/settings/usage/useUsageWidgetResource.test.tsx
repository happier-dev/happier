import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup, flushHookEffects, createDeferred } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { normalizeUsageQuery, getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { useUsageWidgetResource, useUsageWidgetBodyModel } from './useUsageWidgetResource';
import type { UsageWidgetQueryPlan } from './usageWidgetQueries';

const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
function plan(query: UsageQuery): UsageWidgetQueryPlan {
    const row = { query, key: getUsageQueryKey(query), resolution: { status: 'ready' as const, input: { metric: query.metric } } };
    return { scope: { serverId: home!.homes.a!.id, accountId: 'account-a' },
        input: { queries: [query] }, widgets: new Map([['first', row], ['second', row]]) };
}
async function mountHome(route: Parameters<typeof serveAccountHomes>[0]['route']) {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widgets.test', accountId: 'account-a' }], route });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    return (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
}
afterEach(() => { standardCleanup(); retireActiveServerAccountScopeLifetime(); invalidateUsageQueryResources(); home?.dispose(); home = undefined; });

describe('Usage widget shared Resource selection', () => {
    it('does not relabel a foreign Account query intent as the current Account read', async () => {
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const foreign = { ...queryPlan, scope: { ...queryPlan.scope, accountId: 'account-b' } };
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: foreign }), 'first'),
        { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice).toBeNull();
        expect(hook.getCurrent().requestedQuery).toBeNull();
    });

    it('shares the exact slice between widget bodies and removes it on Home authority refusal', async () => {
        let denied = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? denied ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const hook = await renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return { first: useUsageWidgetBodyModel(resource, 'first'), second: useUsageWidgetBodyModel(resource, 'second') };
        }, { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().first.slice?.accounting).toEqual(accounting);
        expect(hook.getCurrent().second.slice).toBe(hook.getCurrent().first.slice);
        denied = true;
        await act(async () => { await hook.getCurrent().first.refresh(); });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().first.slice).toBeNull();
        expect(hook.getCurrent().first.shownQuery).toBeNull();
        expect(hook.getCurrent().first.error).toBeTruthy();
    });

    it('shows a named previous period only, drops a basis change, and ignores late completion after retirement', async () => {
        const delayed = createDeferred<Response>();
        let held = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? delayed.promise : Response.json(accounting) : undefined);
        const hook = await renderHook(({ startMs, costBasis }: { startMs: number; costBasis: 'auto' | 'reported' }) => {
            const resource = useUsageWidgetResource({ credentials, enabled: true,
                plan: plan(normalizeUsageQuery({ period: { startMs }, granularity: 'day', costBasis })) });
            return useUsageWidgetBodyModel(resource, 'first');
        }, { initialProps: { startMs: 1000, costBasis: 'auto' }, flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice?.accounting).toEqual(accounting);
        held = true;
        await hook.rerender({ startMs: 2000, costBasis: 'auto' });
        expect(hook.getCurrent().updatingPreviousPeriod).toBe(true);
        expect(hook.getCurrent().shownQuery?.query.period).toEqual({ startMs: 1000 });
        expect(hook.getCurrent().requestedQuery?.query.period).toEqual({ startMs: 2000 });
        await hook.rerender({ startMs: 2000, costBasis: 'reported' });
        expect(hook.getCurrent().slice).toBeNull();
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); delayed.resolve(Response.json(accounting)); });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().slice).toBeNull();
        expect(hook.getCurrent().requestedQuery).toBeNull();
    });

    it('says shown facts are being re-read only while their own read is in flight, not while another source is outstanding', async () => {
        const delayed = createDeferred<Response>();
        let held = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? delayed.promise : Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan }), 'first'),
        { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice?.accounting).toEqual(accounting);
        // Quota, Work and How-you-work have no producer in this Home: their state belongs to their own lines.
        expect(hook.getCurrent().refreshing).toBe(false);
        held = true;
        let refreshed: Promise<void> | undefined;
        await act(async () => { refreshed = hook.getCurrent().refresh(); });
        await flushHookEffects({ cycles: 5 });
        expect(hook.getCurrent().slice?.accounting).toEqual(accounting);
        expect(hook.getCurrent().refreshing).toBe(true);
        await act(async () => { delayed.resolve(Response.json(accounting)); await refreshed; });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().refreshing).toBe(false);
    });
});
