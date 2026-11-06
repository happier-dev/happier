import { expect, it } from 'vitest';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, encodeUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import { usageAnalyticsRequestToQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsageAccountingSnapshotPrices } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { createUsageAccountingReader } from './usageAccountingReader';
import { allocateUsageOutcomes } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { summarizeUsageWork } from '@/components/settings/usage/widgets/usageWorkPresentation';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { readUsageContributionProjection } from '@happier-dev/protocol/usage/usageCost';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 }, includeSeries: false });
const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
    tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } };
function reader(transport: CapturedServerReadTransport) {
    return createUsageAccountingReader({ credentials: { token: 'test' }, readTransport: transport,
        request: async () => { throw new Error('Unexpected scalar read'); } }, new AbortController().signal);
}

it('requests compact Work rows and preserves allocation, money modes and local repricing', async () => {
    const home = await upsertServerProfile({ serverUrl: 'https://compact-work.test', name: 'Compact Work' });
    // Only Home discovery and accounting HTTP belong to this reader contract;
    // starting Auth/Sync would prepare unrelated application surfaces here.
    setRuntimeFetch(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({ ok: true });
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        throw new Error(`Unexpected Work discovery request: ${path}`);
    });
    try {
        const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
        const rich: UsageAnalyticsQueryResponse = { ...value, contributions: [{ id: 'work', observedAtMs: 500,
            sessionId: 'session', turnId: 'turn', agentId: 'agent', modelId: 'model', machineId: 'machine',
            projectKey: 'project', workspaceId: 'workspace', source: 'runtime', eventCount: 1, tokens, tokenCategories: tokens,
            providerConnectionId: 'connection', sourceContext: { path: 'runtime', execution: 'happier' },
            cost: { reportedUsd: 2, estimatedUsd: 3, apiEquivalentUsd: 4, currency: 'USD' } }] };
        const requests: Headers[] = [];
        const accounting = reader({ key: 'work-projection', serverId: home.id, async read(_path, init, _options, consume) {
            const body = JSON.parse(String(init?.body));
            requests.push(new Headers(init?.headers));
            const request = UsageAnalyticsQueryBatchRequestSchema.parse(body);
            return consume(new Response([...projectUsageAnalyticsBatchDelivery(
                { v: 1, results: [{ query, value: rich }] }, request, true,
                readUsageContributionProjection(new Headers(init?.headers).get('accept')))]
                .map(chunk => JSON.stringify(encodeUsageAnalyticsBatchDelivery(chunk))).join('\n'),
                { headers: { 'Content-Type': 'application/x-ndjson' } }));
        } });
        const work = await accounting.read(query, undefined, true, false, true);
        expect(requests.map(headers => headers.get('accept'))).toEqual(['application/x-ndjson; contribution-encoding=dictionary; contribution-projection=work']);
        expect(work.contributions![0]).not.toHaveProperty('providerConnectionId');
        expect(work.contributions![0]!.sourceContext).toEqual(rich.contributions![0]!.sourceContext);
        for (const costBasis of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
            const presentation = (rows: NonNullable<UsageAnalyticsQueryResponse['contributions']>) => summarizeUsageWork(
                allocateUsageOutcomes({ contributions: rows, evidence: [] }), { metric: 'cost', costBasis });
            expect(presentation(work.contributions!)).toEqual(presentation(rich.contributions!));
        }
        const rates = { model: { kind: 'rates' as const, inputUsdPerMillion: 9, outputUsdPerMillion: 0 } };
        const repriced = repriceUsageAnalyticsResponse(work, undefined, rates);
        expect(repriced.contributions?.map(row => row.cost))
            .toEqual(repriceUsageAnalyticsResponse(rich, undefined, rates).contributions?.map(row => row.cost));
        expect(repriced.contributions![0]!.cost.apiEquivalentUsd).toBe(9);
        const full = await accounting.read(query, undefined, true);
        expect(full.contributions![0]!.providerConnectionId).toBe('connection');
        const older = reader({ key: 'older-home', async read(_path, _init, _options, consume) {
            return consume(Response.json({ v: 1, results: [{ query, value: rich }] }));
        } });
        expect((await older.read(query, undefined, true, false, true)).contributions![0]!.providerConnectionId).toBe('connection');
    } finally { resetRuntimeFetch(); resetServerFeaturesClientForTests(); }
});

it.each([false, true])('admits compact server prices and preserves rich repricing, detail=%s', async detail => {
    const catalog = { v: 1 as const, models: { model: { inputUsdPerMillion: 7, outputUsdPerMillion: 0 } },
        provenance: { source: 'litellm' as const, origin: 'bundled' as const, revision: 'server-prices',
            asOfMs: 1, fetchStatus: 'ready' as const } };
    for (const count of [1, 128]) {
        const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
        const rich = repriceUsageAnalyticsResponse({ ...value, priceCatalog: catalog,
            totals: { eventCount: count, tokens: { ...tokens, input: count * tokens.input, total: count * tokens.total }, cost: value.totals.cost },
            contributions: Array.from({ length: count }, (_, index) => ({ id: String(index), observedAtMs: 500,
                sessionId: null, turnId: null, agentId: null, modelId: 'model', machineId: null, projectKey: null,
                workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost: value.totals.cost })) });
        const request = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [query],
            contributionQueries: detail ? [query] : [], sessionQueries: [] });
        const delivery = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery(
            { v: 1, priceCatalog: catalog, results: [{ query, value: rich }] }, request, true));
        const accounting = reader({ key: `priced-${detail}-${count}`, async read(_path, _init, _options, consume) {
            return consume(Response.json(delivery));
        } });
        const admitted = await accounting.read(query, undefined, detail);
        let lookups = 0;
        const models = admitted.priceCatalog!.models;
        admitted.priceCatalog!.models = new Proxy(models, { get(target, key, receiver) {
            lookups++; return Reflect.get(target, key, receiver);
        } });
        const requested = { ...usageAnalyticsRequestToQuery(query), includeContributions: detail,
            includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false };
        const initial = projectUsageAccountingSnapshotPrices({ query: requested, status: 'available', value: admitted }, undefined);
        if (detail) expect(lookups, 'rich rows still admit their exact decimal operands locally').toBeGreaterThan(0);
        else expect.soft(lookups, `${count} freshly admitted rows must not replay the server's compact tariff projection`).toBe(0);
        expect(initial.priceProjection!.value.totals.cost.apiEquivalentUsd).toBe(count * 7);
        const changed = projectUsageAccountingSnapshotPrices(initial,
            { model: { kind: 'rates', inputUsdPerMillion: 9, outputUsdPerMillion: 0 } });
        expect(changed.priceProjection!.value.totals.cost.apiEquivalentUsd).toBe(count * 9);
        expect(projectUsageAccountingSnapshotPrices(changed, undefined).priceProjection!.value.totals.cost.apiEquivalentUsd).toBe(count * 7);
        const updatedCatalog = { ...admitted.priceCatalog!, models: { model: { inputUsdPerMillion: 11, outputUsdPerMillion: 0 } },
            provenance: { ...catalog.provenance, revision: 'new-prices' } };
        const updated = projectUsageAccountingSnapshotPrices({ query: requested, status: 'available',
            value: { ...admitted, priceCatalog: updatedCatalog } }, undefined);
        expect(updated.priceProjection!.value.totals.cost.apiEquivalentUsd).toBe(count * 11);
    }
});

it('accepts a valid totals-only answer without inventing a missing contribution-page stream', async () => {
    const accounting = reader({ key: 'incumbent', async read(_path, _init, _options, consume) {
        return consume(Response.json({ v: 1, results: [{ query, value }] }));
    } });
    await expect(accounting.read(query, undefined, true)).resolves.toEqual(value);
});

it('publishes private membership only to the borrower that requested it', async () => {
    const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [query], contributionQueries: [], sessionQueries: [query] });
    const response = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1, results: [{ query,
        value: { ...value, contributions: [{ id: 'event', observedAtMs: 500, sessionId: 'session', turnId: 'turn', agentId: null,
            modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
            tokens: value.totals.tokens, cost: value.totals.cost }] } }] }, input, false));
    const accounting = reader({ key: 'compact', async read(_path, _init, _options, consume) {
        return consume(Response.json(response));
    } });
    const [facts, privateFacts] = await Promise.all([accounting.read(query, undefined, false, false),
        accounting.read(query, undefined, false, true)]);
    expect(privateFacts.sessionIds).toEqual(['session']);
    expect(privateFacts.sessionMembership?.turns).toHaveLength(1);
    expect(facts).not.toHaveProperty('sessionIds');
    expect(facts).not.toHaveProperty('sessionMembership');
    expect(facts.totals).toEqual(privateFacts.totals);
});
