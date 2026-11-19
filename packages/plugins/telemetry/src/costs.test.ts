import { projectAppCallsUsageV1 } from '@happier-dev/plugin-sdk/usage';
import { expect, it } from 'vitest';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import * as database from '@happier-dev/database-protocol';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createCaptureRuntime } from './runtime.js';
import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';
import { localCaptureBackground } from './background.js';
import { captureMigrations } from './store/capture.js';
import { createCaptureSqliteFixture } from './testing/sqlite.js';

const source = { kind: 'environment' as const, serverId: 'home', environmentId: 'app' };
const partition = 'environment:app';
const tokens = { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: null };
const metadata = { provider: 'openai', modelId: 'private-model', requestedModel: 'private-model', operation: 'chat',
    tokens, tokenCategories: tokens, reportedCost: { amount: 7, currency: 'EUR' } };
const catalog: UsageModelPriceCatalog = { v: 1, models: { reference: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
    provenance: { source: 'litellm', origin: 'fetched', asOfMs: 1, revision: 'cost-fixture', fetchStatus: 'ready' } };

async function fixture() {
    const sqlite = createCaptureSqliteFixture();
    for (const migration of captureMigrations) await migration.up(sqlite.db);
    const runtime = createCaptureRuntime({ database: sqlite.db, publish() {}, normalizeStatement: createPostgresqlObservationNormalizer() });
    return { ...sqlite, runtime };
}

it('persists numeric GenAI operands only for the admitted app-cost opt-in and never stores prompts in details', async () => {
    const f = await fixture();
    try {
        for (const enabled of [true, false, undefined]) {
            const selected = `environment:${String(enabled)}`;
            const receiver = await f.runtime.acquireReceiver({ port: 0, context: { partition: selected,
                ...(enabled === undefined ? {} : { capabilities: { appLlmCost: enabled } }) } });
            try {
                const response = await fetch(`${receiver.endpoint}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [
                        { key: 'service.name', value: { stringValue: 'api' } }, { key: 'service.version', value: { stringValue: 'build' } },
                    ] }, scopeSpans: [{ spans: [{ traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef',
                        name: 'chat', kind: 3, startTimeUnixNano: '1000000000', endTimeUnixNano: '1001000000', attributes: [
                            { key: 'gen_ai.request.model', value: { stringValue: 'private-model' } },
                            { key: 'gen_ai.usage.input_tokens', value: { intValue: '1000000' } },
                            { key: 'gen_ai.usage.output_tokens', value: { intValue: '500000' } },
                            { key: 'gen_ai.input.messages', value: { stringValue: 'private-prompt' } },
                            { key: 'gen_ai.output.messages', value: { stringValue: 'private-completion' } },
                            { key: 'gen_ai.tool.call.arguments', value: { stringValue: 'private-tool' } },
                        ] }] }] }] }) });
                expect(response.status).toBe(200);
                await f.runtime.ingest.settled();
                const rows = await f.runtime.store.costOperands({ worktree: selected, since: 1000, until: 2000,
                    serviceName: 'api', serviceVersion: 'build' });
                expect(rows).toHaveLength(enabled === true ? 1 : 0);
                const detail = await f.runtime.store.detail(selected, 'span:1234567890abcdef1234567890abcdef:1234567890abcdef');
                expect(JSON.stringify(detail)).not.toMatch(/private-prompt|private-completion|private-tool|genAi/);
            } finally { await receiver.release(); }
        }
    } finally { await f.runtime.ingest.settled(); f.close(); }
});

it('reads one selected cost aggregate through the published Action and prices it using real Usage with the invoking viewer preference', async () => {
    const f = await fixture();
    const calls: Array<{ id: string; input: unknown }> = [];
    let summaryOnly = false;
    // These are the SDK host's authenticated Account Actions, not a replacement estimator.
    const actions = { async execute(id: string, input: unknown) {
        calls.push({ id, input });
        if (id === 'settings.get') return summaryOnly ? { anchor: 'usage.modelPrices', unset: true }
            : { anchor: 'usage.modelPrices', value: { 'private-model': { kind: 'map', modelId: 'reference' } } };
        if (id === 'usage.prices.get') return summaryOnly ? { v: 1, modelCount: 1, provenance: catalog.provenance } : catalog;
        throw new Error(`Unexpected host Action ${id}`);
    } } as unknown as PluginServices['actions'];
    let admissions = 0;
    const storage = { daemon: { database: async () => f.db } } as unknown as PluginServices['storage'];
    const deploymentDatabases = { async admitTelemetryRead() {
        admissions++;
        return { environment: { serverId: source.serverId, environmentId: source.environmentId, revision: 1 },
            collectorMachineId: 'collector', capabilities: { queries: true, traces: true, appLlmCost: true } };
    } } as unknown as PluginServices['deploymentDatabases'];
    const lease = await localCaptureBackground.acquireRuntime({ signal: new AbortController().signal, services: { storage } });
    const plugin = definePlugin({ id: 'happier.telemetry', version: '0.0.0', displayName: 'App cost', actions: {
        'test/priced': { title: 'Fixture viewer pricing', readOnly: true, execution: { target: 'daemon' }, async run(_input, context) {
            const costs = await import('./costs.js');
            const window = await costs.readCaptureCostWindow(f.runtime, { worktree: partition, since: 1000, until: 2000, granularity: 'hour' });
            const pricing = await costs.loadCaptureCostPricingContext(context, summaryOnly ? [] : ['private-model']);
            const usage = projectAppCallsUsageV1(window, pricing.catalog,
                pricing.viewerOverrides, { granularity: 'hour' });
            return projectNativeJsonValueForTransport({ ...usage,
                accounting: UsageAnalyticsQueryResponseSchema.parse(usage.accounting) });
        } },
    } });
    const host = await createPluginTestkit({ manifest: DATABASE_CAPTURE_PLUGIN.manifest, module: DATABASE_CAPTURE_PLUGIN,
        services: { storage, actions, deploymentDatabases } });
    const pricingHost = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { actions } });
    try {
        await f.runtime.store.write([{ id: 'call', kind: 'span', source: 'otlp', worktree: partition,
            at: 1000, serviceName: 'api', genAi: metadata }]);
        const rawRead = host.invokeAction(database.databaseActionLocalIdV1(database.TELEMETRY_COSTS_READ_ACTION_ID_V1), {
            source, since: 1000, until: 2000, granularity: 'hour' });
        await expect(rawRead).resolves.toMatchObject({ ok: true, coverage: { callCount: 1, tokenCategoryCallCount: 1, reportedCostCallCount: 1 },
            items: [{ reportedCost: { amount: 7, currency: 'EUR' } }] });
        const raw = database.DatabaseCaptureCostsReadResultV1Schema.parse(await rawRead);
        expect(admissions).toBe(1);
        const pricedRead = pricingHost.invokeAction('test/priced', {});
        await expect(pricedRead).resolves.toMatchObject({ subject: 'app_calls' });
        const priced = await pricedRead;
        expect(priced).toMatchObject({ subject: 'app_calls', accounting: { totals: { cost: { apiEquivalentUsd: 4 } },
            priceCatalog: { provenance: { revision: 'cost-fixture' } },
            costFacts: expect.arrayContaining([expect.objectContaining({ kind: 'reported', currency: 'EUR', amountUsd: 7 })]) } });
        const usage = projectAppCallsUsageV1(raw.ok ? raw : (() => { throw new Error('Cost read failed'); })(),
            catalog, { 'private-model': { kind: 'map', modelId: 'reference' } }, { granularity: 'hour' });
        expect(resolveUsageCostBasis(usage.accounting.totals.cost, 'api_equivalent')?.amountUsd).toBe(4);
        expect(calls).toEqual([{ id: 'settings.get', input: { anchor: 'usage.modelPrices' } },
            { id: 'usage.prices.get', input: { modelIds: ['private-model', 'reference'] } }]);
        summaryOnly = true;
        calls.length = 0;
        const unpriced = await pricingHost.invokeAction('test/priced', {});
        expect(unpriced).toMatchObject({ accounting: { priceCatalog: { models: {}, provenance: { revision: 'cost-fixture' } },
            costFacts: expect.arrayContaining([expect.objectContaining({ kind: 'unpriced', eventCount: 1 })]) } });
        expect(calls).toEqual([{ id: 'settings.get', input: { anchor: 'usage.modelPrices' } },
            { id: 'usage.prices.get', input: { modelIds: [] } }]);
    } finally { await pricingHost.dispose(); await host.dispose(); await lease.release(); f.close(); }
});
