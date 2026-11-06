import { afterEach, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryBatchRequestSchema, type UsageAnalyticsQueryBatchResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { encodeUsageAnalyticsBatchDelivery } from '@happier-dev/protocol/usage/usageCost';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getServerFeaturesSnapshot, primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { parseServerFeatures } from '@/sync/api/capabilities/serverFeaturesParse';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { queryUsageAnalyticsBatch } from './apiUsageBatch';

const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [{ dateRange: { startMs: 0, endMs: 1000 } }],
    contributionQueries: [], sessionQueries: [] });
const legacyBody = JSON.stringify({ queries: input.queries, includeContributions: true });

it.each(['stream', 'buffered', 'older-home'] as const)('admits identical contribution operands from %s NDJSON', async mode => {
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const chunk: UsageAnalyticsQueryBatchResponse = { v: 1, results: [], contributionPages: [{
        query: input.queries[0]!, offset: 0, totalCount: 1, nextOffset: null, rows: [{
            id: 'event', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: 'agent', modelId: null,
            machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens,
            cost: { reportedUsd: 0, estimatedUsd: 1, currency: 'USD' },
        }],
    }] };
    const transport: CapturedServerReadTransport = { key: 'dictionary-accounting', async read(_path, init, _options, consume) {
        expect(new Headers(init?.headers).get('accept')).toContain('contribution-encoding=dictionary');
        const response = new Response(JSON.stringify(mode === 'older-home' ? chunk : encodeUsageAnalyticsBatchDelivery(chunk)) + '\n',
            { headers: { 'Content-Type': 'application/x-ndjson' } });
        if (mode === 'buffered') Object.defineProperty(response, 'body', { value: null });
        return consume(response);
    } };
    const chunks: UsageAnalyticsQueryBatchResponse[] = [];
    await queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk: value => chunks.push(value) });
    expect(chunks).toEqual([chunk]);
});

it.each(['json', 'ndjson'] as const)('carries only safe issue codes and paths for rejected %s accounting', async wire => {
    const payload = { v: 1, results: [{ query: input.queries[0], value: { v: 1,
        totals: { eventCount: 1, tokens: { input: 'private-value-must-not-leak', output: 0, reasoning: 0,
            cacheRead: 0, cacheWrite: 0, total: 1 }, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } } }] };
    let responsePayload: unknown = payload;
    const transport: CapturedServerReadTransport = { key: 'invalid-accounting', async read(_path, _init, _options, consume) {
        return consume(wire === 'json' ? Response.json(responsePayload) : new Response(JSON.stringify(responsePayload) + '\n',
            { headers: { 'Content-Type': 'application/x-ndjson' } }));
    } };
    const result = await queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk() {} }).then(() => undefined, (error: unknown) => error);
    expect(result).toMatchObject({ code: 'usage_query_result_invalid', details: { issues: expect.arrayContaining([
        { code: 'invalid_type', path: ['results', 0, 'value', 'totals', 'tokens', 'input'] },
    ]) } });
    expect(JSON.stringify(result)).not.toContain('private-value-must-not-leak');
    responsePayload = { v: 1, results: [{ query: input.queries[0], value: { v: 1, totals: { eventCount: 1,
        tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', breakdown: {
            'private-dictionary-key-must-not-leak': 'private-dictionary-value' } } } } }] };
    const privateKey = await queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk() {} }).then(() => undefined, (error: unknown) => error);
    expect(privateKey).toMatchObject({ code: 'usage_query_result_invalid', details: { issues: expect.arrayContaining([
        { code: 'invalid_type', path: ['results', 0, 'value', 'totals', 'cost', 'breakdown', '*'] },
    ]) } });
    expect(JSON.stringify(privateKey)).not.toContain('private-dictionary');
});

afterEach(() => {
    resetRuntimeFetch();
    resetServerFeaturesClientForTests();
});

it.each(['absent', 'disabled'] as const)('keeps exact legacy request bytes for a captured Home with %s compact support', async advert => {
    const current = createRootLayoutFeaturesResponse();
    const { usage: _usage, ...withoutUsage } = current.features;
    const features = parseServerFeatures({ ...current, features: advert === 'absent' ? withoutUsage
        : { ...withoutUsage, usage: { compactBatch: { enabled: false } } } });
    expect(features).not.toBeNull();
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId,
        snapshot: { status: 'ready', features: current } });
    primeServerFeaturesSnapshot({ serverId: 'older-usage-home', snapshot: { status: 'ready', features: features! } });
    const transport: CapturedServerReadTransport = { serverId: 'older-usage-home', key: 'opaque-read-binding', async read(_path, init, _options, consume) {
        expect(init?.body).toBe(legacyBody);
        return consume(Response.json({ v: 1, results: [] }));
    } };
    await queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk() {} });
});

it('uses the captured Home advert rather than the active Home or opaque transport key', async () => {
    const old = parseServerFeatures({ features: {}, capabilities: {} });
    expect(old).not.toBeNull();
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features: old! } });
    primeServerFeaturesSnapshot({ serverId: 'compact-usage-home',
        snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({ features: { usage: { compactBatch: { enabled: true } } } }) } });
    const transport: CapturedServerReadTransport = { serverId: 'compact-usage-home', key: 'reload-78', async read(_path, init, _options, consume) {
        expect(init?.body).toBe(JSON.stringify(input));
        return consume(Response.json({ v: 1, results: [] }));
    } };
    await queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk() {} });
});

it('joins cold Home feature discovery before sending one compact accounting request', async () => {
    const home = await upsertServerProfile({ serverUrl: 'https://cold-compact-usage.example.test', name: 'Cold compact Usage' });
    let resolveFeatures!: (response: Response) => void;
    const featuresResponse = new Promise<Response>(resolve => { resolveFeatures = resolve; });
    const featuresReads: string[] = [];
    setRuntimeFetch(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({ ok: true });
        if (path !== '/v1/features') throw new Error(`Unexpected feature request: ${path}`);
        featuresReads.push(String(url));
        return featuresResponse;
    });
    const bodies: unknown[] = [];
    const transport: CapturedServerReadTransport = { serverId: home.id, key: 'cold-read-binding', async read(_path, init, _options, consume) {
        bodies.push(init?.body);
        return consume(Response.json({ v: 1, results: [] }));
    } };
    const existingDiscovery = getServerFeaturesSnapshot({ serverId: home.id });
    const accounting = queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk() {} });
    await vi.waitFor(() => expect(featuresReads).toHaveLength(1));
    const bodiesBeforeDiscovery = [...bodies];
    resolveFeatures(Response.json(createRootLayoutFeaturesResponse({ features: { usage: { compactBatch: { enabled: true } } } })));
    await Promise.all([existingDiscovery, accounting]);
    expect(bodiesBeforeDiscovery).toEqual([]);
    expect(featuresReads).toEqual([`${home.serverUrl}/v1/features`]);
    expect(bodies).toEqual([JSON.stringify(input)]);
});

it('settles malformed feature discovery as one legacy accounting request without a 400 retry', async () => {
    const home = await upsertServerProfile({ serverUrl: 'https://malformed-compact-usage.example.test', name: 'Malformed compact Usage' });
    let featureReads = 0;
    setRuntimeFetch(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({ ok: true });
        if (path !== '/v1/features') throw new Error(`Unexpected feature request: ${path}`);
        featureReads++;
        return Response.json({ features: { usage: { compactBatch: { enabled: 'yes' } } }, capabilities: {} });
    });
    const bodies: unknown[] = [];
    const transport: CapturedServerReadTransport = { serverId: home.id, key: 'malformed-read-binding', async read(_path, init, _options, consume) {
        bodies.push(init?.body);
        return consume(new Response(null, { status: 400 }));
    } };
    await expect(queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk() {} })).rejects.toMatchObject({ status: 400, code: 'usage_query_failed' });
    expect(featureReads).toBe(1);
    expect(bodies).toEqual([legacyBody]);
});

it('does not borrow an active Home advert when a legacy transport has no captured Home', async () => {
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId,
        snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({ features: { usage: { compactBatch: { enabled: true } } } }) } });
    const transport: CapturedServerReadTransport = { key: 'legacy-caller', async read(_path, init, _options, consume) {
        expect(init?.body).toBe(legacyBody);
        return consume(Response.json({ v: 1, results: [] }));
    } };
    await queryUsageAnalyticsBatch({ token: 'test' }, input, { readTransport: transport,
        signal: new AbortController().signal, onChunk() {} });
});
