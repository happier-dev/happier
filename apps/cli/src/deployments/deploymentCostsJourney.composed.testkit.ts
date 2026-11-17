import { expect, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseCaptureCostsReadResultV1Schema, TELEMETRY_COSTS_READ_ACTION_ID_V1, TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1, TELEMETRY_METRICS_READ_ACTION_ID_V1, TelemetryMetricsReadResultV1Schema } from '@happier-dev/database-protocol';
import { projectDatabaseCaptureUsageV1, projectDatabaseAppCostMetricSeriesV1 } from '@happier-dev/database-protocol';
import { HealthCheckResultV1ProtocolSchema } from '@happier-dev/protocol/deployments/healthCheckV1';
import { UsageModelPriceCatalogSchema, UsageModelPriceOverridesV1Schema } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { configuration } from '@/configuration';
import { createUsageObservationPublisher } from '@/usage/createUsageObservationPublisher';
import type { readS0ControllerCredentials } from './deploymentDaemonIngress.testkit';

type Viewer = Readonly<{ accountId: string; accepted(name: string, input: unknown): Promise<unknown> }>;
const settingSchema = z.object({ anchor: z.literal('usage.modelPrices'), value: z.unknown() });
const emittedSchema = z.object({ attempts: z.literal(4), producer: z.object({ serviceName: z.string(), serviceVersion: z.string().optional() }) });
const healthSetupSchema = z.object({ sourceInstanceId: z.string() });

/** Seed through the ordinary mode-aware Session writer and Agent observation publisher. */
export async function createProductionCostsAgentBaseline(input: Readonly<{
    serverUrl: string; machineId: string; credentials: ReturnType<typeof readS0ControllerCredentials>; signal: AbortSignal;
}>) {
    const api = await ApiClient.create(input.credentials);
    const initial = createSessionMetadata({ flavor: 'codex', machineId: input.machineId, directory: configuration.happyHomeDir,
        launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }) });
    const session = await runWithServerHttpBaseUrl(input.serverUrl, () => api.getOrCreateSession({
        tag: `f17-agent-${randomUUID()}`, ...initial, signal: input.signal,
    }));
    if (!session) throw new Error('F17 requires a real Agent Session baseline');
    const publisher = createUsageObservationPublisher({ token: input.credentials.token, apiServerUrl: input.serverUrl,
        emitUsageEvent: () => null });
    const published = await publisher.publish({ sessionId: session.id, signal: input.signal, externalKey: 'f17-agent-sentinel',
        turnId: 'f17-agent-turn', observation: { provider: 'codex', source: 'runtime', scope: 'turn_delta',
            key: 'f17-agent-sentinel', modelId: 'dbw-f17-agent-sentinel',
            tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 10 }, cost: null,
            contextUsedTokens: null, contextWindowTokens: null } });
    expect(published.status).toBe('sent');
    return session.id;
}

/** F17 extends the real SDK exporter and two Account-bound Action executors from F14.
 * The collector returns the same authorized raw calls; each viewer's persisted settings price them. */
export async function runProductionCostsJourney(input: Readonly<{
    serverId: string; environmentId: string; appUrl: string; signal: AbortSignal;
    /** A fixture Session with a real, already published Agent usage observation. */
    agentSessionId: string;
    owner: Viewer; teammate: Viewer;
    collectorMachineId: string;
    acceptedOnCollector(name: string, value: unknown): Promise<unknown>;
}>) {
    expect(input.owner.accountId).not.toBe(input.teammate.accountId);
    const request = async (path: string) => {
        const response = await fetch(new URL(path, input.appUrl), { signal: input.signal });
        expect(response.status, path).toBe(200);
        return response;
    };
    const viewers = [input.owner, input.teammate];
    const readAgentContributions = async () => {
        const accountingOnly = { includeContributions: true, includeComparison: false, includeQuota: false,
            includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
            includeWorkEvidence: false, includeCoach: false };
        const batch = UsageQueryBatchResultSchema.parse(await input.owner.accepted('usage.query', { queries: [
            { ...accountingOnly, session: input.agentSessionId },
            // Catch an erroneous App ledger write even if it omits Session identity, without selecting unrelated traffic.
            { ...accountingOnly, modelIds: ['dbw-f17-priced', 'dbw-f17-unpriced'] },
        ] }));
        return batch.results.map(slice => {
            expect(slice.accounting).toBeDefined();
            expect(slice.accounting?.contributions).toBeDefined();
            return { session: slice.shownQuery.session, modelIds: slice.shownQuery.modelIds,
                contributions: [...(slice.accounting?.contributions ?? [])].sort((left, right) => left.id.localeCompare(right.id)) };
        });
    };
    const originals = await Promise.all(viewers.map(async viewer => settingSchema.parse(
        await viewer.accepted('settings.get', { anchor: 'usage.modelPrices' })).value));
    try {
        for (const [index, viewer] of viewers.entries()) {
            await viewer.accepted('settings.set', { anchor: 'usage.modelPrices', value: {
                'dbw-f17-priced': { kind: 'rates', inputUsdPerMillion: index + 1, outputUsdPerMillion: 2 * (index + 1),
                    cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0 },
            } });
        }
        const agentBefore = await readAgentContributions();
        expect(agentBefore.some(slice => slice.contributions.some(row => row.sessionId === input.agentSessionId))).toBe(true);
        const since = Date.now();
        const emitted = emittedSchema.parse(await (await request('/llm')).json());
        await request('/flush'); // The genuine SDK owns protobuf encoding, HTTP, export completion and retry identity.
        const operands = { source: { kind: 'environment' as const, serverId: input.serverId, environmentId: input.environmentId },
            since, until: Date.now(), serviceName: emitted.producer.serviceName,
            ...(emitted.producer.serviceVersion ? { serviceVersion: emitted.producer.serviceVersion } : {}), granularity: 'hour' as const };
        const read = async (viewer: Viewer) => {
            const result = DatabaseCaptureCostsReadResultV1Schema.parse(await viewer.accepted(TELEMETRY_COSTS_READ_ACTION_ID_V1, operands));
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(`F17 cost read unavailable: ${result.code}`);
            return result;
        };
        const ownerRead = await vi.waitFor(async () => {
            const result = await read(input.owner);
            expect(result.coverage.callCount).toBe(emitted.attempts);
            return result;
        });
        const teammateRead = await read(input.teammate);
        expect(teammateRead).toEqual(ownerRead);
        expect(ownerRead.coverage).toMatchObject({ callCount: 4, tokenCategoryCallCount: 3, reportedCostCallCount: 1 });
        expect(ownerRead.items.some(item => item.tokenCategories === null)).toBe(true);
        expect(ownerRead.items.some(item => item.modelId === 'dbw-f17-unpriced')).toBe(true);
        expect(ownerRead.items.find(item => item.reportedCost)?.reportedCost).toEqual({ amount: 0.02, currency: 'USD' });
        expect(JSON.stringify(ownerRead)).not.toMatch(/f17-private-prompt|f17-private-completion|f17-private-tool/);
        const projections = await Promise.all(viewers.map(async (viewer, index) => {
            const overrides = UsageModelPriceOverridesV1Schema.parse(settingSchema.parse(
                await viewer.accepted('settings.get', { anchor: 'usage.modelPrices' })).value);
            const catalog = UsageModelPriceCatalogSchema.parse(await viewer.accepted('usage.prices.get', {
                modelIds: ['dbw-f17-priced', 'dbw-f17-unpriced'],
            }));
            return projectDatabaseCaptureUsageV1(index === 0 ? ownerRead : teammateRead, catalog, overrides, { granularity: 'hour' });
        }));
        expect(projections[0]!.accounting.totals.tokens).toEqual(projections[1]!.accounting.totals.tokens);
        expect(projections[0]!.accounting.totals.cost.apiEquivalentUsd).toBeGreaterThan(0);
        expect(projections[1]!.accounting.totals.cost.apiEquivalentUsd)
            .toBeGreaterThan(projections[0]!.accounting.totals.cost.apiEquivalentUsd!);
        for (const projection of projections) {
            expect(projection.subject).toBe('app_calls');
            expect(projection.accounting.coverage.status).toBe('partial');
            expect(projection.accounting.contributions?.every(row => row.sessionId === null && row.turnId === null && row.agentId === null)).toBe(true);
        }
        // The same saved Key flow kind must use its owning Account's live price preference.
        // This is a demanded finite check; the existing health scheduler remains its sole lifecycle owner.
        for (const [index, viewer] of viewers.entries()) {
            const expected = resolveUsageCostBasis(projections[index]!.accounting.totals.cost, 'api_equivalent');
            expect(expected?.amountUsd).toBeGreaterThan(0);
            const measure = { kind: 'spend', costMode: 'api_equivalent' };
            const demand = TelemetryMetricsReadResultV1Schema.parse(await viewer.accepted(TELEMETRY_METRICS_READ_ACTION_ID_V1, {
                serverId: input.serverId, environmentId: input.environmentId, since: operands.since, until: operands.until,
                serviceName: operands.serviceName, serviceVersion: operands.serviceVersion, measure,
            }));
            expect(demand.result.measurements).toMatchObject({ value: expected!.amountUsd, unit: 'USD',
                basis: 'catalog_estimate', completeness: 'partial' });
            expect(demand.trend).toEqual(projectDatabaseAppCostMetricSeriesV1(projections[index]!));
            expect(demand.usage?.priceCatalog).toEqual(projections[index]!.accounting.priceCatalog);
            expect(demand.usage?.costFacts).toEqual(projections[index]!.accounting.costFacts);
            expect(demand.usage?.coverage).toEqual(projections[index]!.accounting.coverage);
            // The reader Team deliberately has no Machine grant. Only the owner configures
            // the saved observer on the collector; both viewers retain the demand read above.
            if (index !== 0) continue;
            const checkId = 'f17-app-spend';
            const setup = healthSetupSchema.parse(await input.acceptedOnCollector('action.invoke', {
                action: { pluginId: 'happier.machine.services', localId: 'health/setup' },
                input: { v: 1, subject: { kind: 'environment', environmentId: input.environmentId }, checks: [{
                    checkId, kind: { pluginId: 'happier.telemetry', localId: 'key-flow' }, binding: { kind: 'healthCheck' },
                    config: { environmentId: input.environmentId, serviceName: operands.serviceName,
                        serviceVersion: operands.serviceVersion, measure, windowMs: 3_600_000,
                        threshold: { operator: 'above', value: expected!.amountUsd / 2 } },
                    periodMs: 1000, consecutiveFailuresBeforeAlerting: 1,
                }], investigation: { mode: 'inbox' } },
            }));
            const saved = HealthCheckResultV1ProtocolSchema.parse(await input.acceptedOnCollector(TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1, {
                sourceInstanceId: setup.sourceInstanceId, checkId,
            }));
            expect(saved.status).toBe('down');
            expect(saved.cause?.observerMachineId).toBe(input.collectorMachineId);
            expect(saved.measurements).toMatchObject({ value: expected!.amountUsd, unit: 'USD',
                basis: 'catalog_estimate', completeness: 'partial' });
        }
        expect(await readAgentContributions()).toEqual(agentBefore);
        console.info('F17 real SDK calls share raw accounting across two admitted Account price preferences', {
            environmentId: input.environmentId, attempts: emitted.attempts, currency: 'USD',
            ownerAccountId: input.owner.accountId, teammateAccountId: input.teammate.accountId,
        });
    } finally {
        for (const [index, viewer] of viewers.entries()) {
            await viewer.accepted('settings.set', { anchor: 'usage.modelPrices', value: originals[index] });
        }
    }
}
