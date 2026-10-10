import { afterEach, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from './usageQueryResource';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(() => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    home?.dispose();
    home = undefined;
    vi.restoreAllMocks();
});

it('preserves an unchanged batched slice across Resource revisions without sharing it across retired authority', async () => {
    // This is the clock boundary, so unchanged observed source currentness is
    // distinguishable from a real change to one query's accounting facts.
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    let changedCount = 1;
    const accounting = (eventCount: number): UsageAnalyticsQueryResponse => ({ v: 1, totals: {
        eventCount, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
    } });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-stability.test', accountId: 'account-a' }],
        route: request => {
            if (request.path !== '/v2/usage/query') return undefined;
            const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
            return Response.json(accounting(query.filters?.agentIds?.includes('claude') ? changedCount : 1));
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const queries = ['claude', 'codex'].map(agent => normalizeUsageQuery({
        period: { startMs: 1000, endMs: 2000 }, agents: [agent],
    }));
    const reference = { hostRead: 'usage.query' as const, input: { queries } };
    const captured = captureUiUsageQueryAccountContext(credentials);
    if (!captured) throw new Error('Expected admitted Account');
    const entry = getUsageQueryResourceStore(captured).getEntry(reference);
    const release = entry.subscribe(() => {}, false);
    const readReady = async () => {
        await expect.poll(() => {
            const content = entry.getSnapshot().value;
            return content !== undefined && decodeUsageQueryResource(content).results.every(slice =>
                slice.sources.some(source => source.source === 'how_you_work' && source.status !== 'pending'));
        }).toBe(true);
        return decodeUsageQueryResource(entry.getSnapshot().value!);
    };
    try {
        const before = await readReady();
        const firstKey = getUsageQueryKey(queries[0]);
        const siblingKey = getUsageQueryKey(queries[1]);
        const beforeFirst = before.results.find(slice => slice.key === firstKey)!;
        const beforeSibling = before.results.find(slice => slice.key === siblingKey)!;
        changedCount = 2;
        await entry.refresh();
        const after = await readReady();
        expect(after.results.find(slice => slice.key === firstKey)?.accounting?.totals.eventCount).toBe(2);
        expect(after.results.find(slice => slice.key === firstKey)).not.toBe(beforeFirst);
        expect(after.results.find(slice => slice.key === siblingKey)).toBe(beforeSibling);

        retireActiveServerAccountScopeLifetime();
        expect(entry.getSnapshot().value).toBeUndefined();
        const replacement = captureUiUsageQueryAccountContext(credentials);
        if (!replacement) throw new Error('Expected replacement admitted Account');
        expect(replacement.accountLifetime).not.toBe(captured.accountLifetime);
        const replacementEntry = getUsageQueryResourceStore(replacement).getEntry(reference);
        const stopReplacement = replacementEntry.subscribe(() => {}, false);
        try {
            await replacementEntry.refresh();
            const content = replacementEntry.getSnapshot().value;
            expect(content).toBeDefined();
            expect(decodeUsageQueryResource(content!).results.find(slice => slice.key === siblingKey)).not.toBe(beforeSibling);
        } finally { stopReplacement(); }
    } finally { release(); }
});
