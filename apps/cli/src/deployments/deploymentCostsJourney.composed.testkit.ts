import { expect, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseCaptureCostsReadResultV1Schema, TELEMETRY_COSTS_READ_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { usageAppCallsSourceId } from '@happier-dev/plugin-sdk/usage';
import { HealthCheckResultV1ProtocolSchema } from '@happier-dev/protocol/deployments/healthCheckV1';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import * as accountActionTransport from '@/api/externalActionExecutionAuthorization';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { configuration } from '@/configuration';
import { createUsageObservationPublisher } from '@/usage/createUsageObservationPublisher';
import type { readS0ControllerCredentials } from './deploymentDaemonIngress.composed.testkit';
import { adoptProductionTelemetryHealthCheck, productionTelemetryHealthSetupSchema } from './deploymentMetricsJourney.composed.testkit';
import { healthResultProjectionPageSchema } from '../../../../packages/plugins/machine-services/src/healthResultProjection';

type Viewer = Readonly<{ accountId: string; accepted(name: string, input: unknown, machineId?: string): Promise<unknown> }>;
const settingSchema = z.object({ anchor: z.literal('usage.modelPrices'), value: z.unknown() });
const emittedSchema = z.object({ attempts: z.literal(4), producer: z.object({ serviceName: z.string(), serviceVersion: z.string().optional() }) });

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
    serverId: string; serverUrl: string; environmentId: string; appUrl: string; signal: AbortSignal;
    /** A fixture Session with a real, already published Agent usage observation. */
    agentSessionId: string;
    owner: Viewer; teammate: Viewer;
    collectorMachineId: string;
    readCollectorActionFailures(): Promise<readonly unknown[]>;
    collectorAccount: Viewer & { credentials: ReturnType<typeof readS0ControllerCredentials> };
}>) {
    expect(input.owner.accountId).not.toBe(input.teammate.accountId);
    const request = async (path: string) => {
        const response = await fetch(new URL(path, input.appUrl), { signal: input.signal });
        expect(response.status, path).toBe(200);
        return response;
    };
    const viewers = [input.owner, input.teammate, input.collectorAccount];
    expect(input.collectorAccount.accountId).not.toBe(input.owner.accountId);
    expect(input.collectorAccount.accountId).not.toBe(input.teammate.accountId);
    const readAgentAccounting = async () => {
        const accountingOnly = { includeComparison: false, includeQuota: false,
            includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
            includeWorkEvidence: false, includeCoach: false };
        const batch = UsageQueryBatchResultSchema.parse(await input.owner.accepted('usage.query', { queries: [
            { ...accountingOnly, session: input.agentSessionId },
            // Catch an erroneous App ledger write even if it omits Session identity, without selecting unrelated traffic.
            { ...accountingOnly, modelIds: ['dbw-f17-priced', 'dbw-f17-unpriced'] },
        ] }));
        const agent = batch.results.find(slice => slice.shownQuery.session?.includes(input.agentSessionId));
        const appModels = batch.results.find(slice => slice.shownQuery.modelIds.includes('dbw-f17-priced'));
        expect(agent?.accounting?.totals).toMatchObject({ eventCount: 1, tokens: { input: 7, output: 3, total: 10 } });
        expect(appModels?.accounting?.totals.eventCount).toBe(0);
        return { agent: agent?.accounting?.totals, appModels: appModels?.accounting?.totals };
    };
    // These separate Account clients share one CLI process in this fixture.
    // Finish each settings refresh before the next client publishes its scope.
    const originals: unknown[] = [];
    for (const viewer of viewers) {
        originals.push(settingSchema.parse(await viewer.accepted('settings.get', { anchor: 'usage.modelPrices' })).value);
    }
    try {
        for (const [index, viewer] of viewers.entries()) {
            await viewer.accepted('settings.set', { anchor: 'usage.modelPrices', value: {
                'dbw-f17-priced': { kind: 'rates', inputUsdPerMillion: index + 1, outputUsdPerMillion: 2 * (index + 1),
                    cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0 },
            } });
        }
        const agentBefore = await readAgentAccounting();
        const since = Date.now();
        const emitted = emittedSchema.parse(await (await request('/llm')).json());
        await request('/flush'); // The genuine SDK owns protobuf encoding, HTTP, export completion and retry identity.
        const service = { serviceName: emitted.producer.serviceName,
            ...(emitted.producer.serviceVersion ? { serviceVersion: emitted.producer.serviceVersion } : {}) };
        const operands = { source: { kind: 'environment' as const, serverId: input.serverId, environmentId: input.environmentId },
            since, until: Date.now(), ...service, granularity: 'hour' as const };
        const read = async (viewer: Viewer) => {
            const result = DatabaseCaptureCostsReadResultV1Schema.parse(await viewer.accepted(
                TELEMETRY_COSTS_READ_ACTION_ID_V1, operands, input.collectorMachineId));
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
        const readSpend = async (viewer: Viewer) => {
            const transport = vi.spyOn(accountActionTransport, 'dispatchOriginalAccountAction');
            try {
                const batch = UsageQueryBatchResultSchema.parse(await viewer.accepted('usage.query', { queries: [{
                    sources: [usageAppCallsSourceId(input.environmentId)],
                    period: { startMs: operands.since, endMs: operands.until }, granularity: 'hour',
                    costBasis: 'api_equivalent', metric: 'cost', includeSeries: true,
                    includeComparison: false, includeQuota: false, includeQuotaHistory: false,
                    includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
                }] }));
                const slice = batch.results[0]!;
                const accounting = slice.sources.find(source => source.source === 'accounting');
                if (accounting?.status !== 'available') {
                    // The Usage projection only has errorCode. Keep the delivered Action's typed cause separately.
                    const collectorRequests = await Promise.all(transport.mock.calls.flatMap(([request], index) => {
                        const call = transport.mock.results[index];
                        if (request.actionId !== 'action.invoke' || request.target.kind !== 'machine'
                            || request.target.machineId !== input.collectorMachineId || call?.type !== 'return') return [];
                        const settlement: Promise<ActionExecuteResult> = call.value;
                        return [settlement.then(result => ({
                            requestId: request.requestId,
                            code: result.ok ? null : result.errorCode,
                            details: result.ok ? null : result.details ?? null,
                            failureCause: result.ok ? null : result.failureCause ?? null,
                        }), () => ({ requestId: request.requestId, settlement: 'rejected' }))];
                    }));
                    const collectorFailures = await input.readCollectorActionFailures().catch(() => null);
                    console.error('F17 priced accounting failure', redactBugReportSensitiveText(JSON.stringify({
                        viewerAccountId: viewer.accountId, accounting, collectorRequests, collectorFailures,
                    })));
                }
                expect(accounting, redactBugReportSensitiveText(JSON.stringify(accounting ?? null)))
                    .toMatchObject({ status: 'available' });
                expect(slice.accounting?.totals.eventCount).toBe(4);
                expect(slice.accounting?.summary?.catalogRevision).toBeTruthy();
                expect(slice.costFactTotals).toEqual(expect.arrayContaining([
                    expect.objectContaining({ kind: 'reported', amountUsd: 0.02, currency: 'USD' }),
                    expect.objectContaining({ kind: 'unpriced', amountUsd: null }),
                ]));
                return slice;
            } finally {
                transport.mockRestore();
            }
        };
        const ownerSpend = await readSpend(input.owner);
        const teammateSpend = await readSpend(input.teammate);
        expect(teammateSpend.accounting?.totals.tokens).toEqual(ownerSpend.accounting?.totals.tokens);
        const amount = (slice: typeof ownerSpend) => resolveUsageCostBasis(slice.accounting!.totals.cost, 'api_equivalent')!.amountUsd;
        expect(amount(ownerSpend)).toBeGreaterThan(0);
        expect(amount(teammateSpend)).toBeCloseTo(2 * amount(ownerSpend));
        expect(teammateSpend.accounting?.series).toEqual(expect.arrayContaining([
            expect.objectContaining({ cost: expect.objectContaining({ apiEquivalentUsd: expect.any(Number) }) }),
        ]));

        // The collector Account runs the observer. The partial monetary population cannot settle a threshold.
        const checkId = 'f17-app-spend';
        const measure = { kind: 'spend', costMode: 'api_equivalent' };
        const onCollector = (name: string, value: unknown) => input.collectorAccount.accepted(name, value, input.collectorMachineId);
        const setup = productionTelemetryHealthSetupSchema.parse(await onCollector('action.invoke', {
            action: { pluginId: 'happier.machine.services', localId: 'health/setup' },
            input: { v: 1, subject: { kind: 'environment', environmentId: input.environmentId }, checks: [{
                checkId, kind: { pluginId: 'happier.telemetry', localId: 'key-flow' }, binding: { kind: 'healthCheck' },
                config: { environmentId: input.environmentId, ...service, measure, windowMs: 3_600_000,
                    threshold: { operator: 'above', value: amount(ownerSpend) / 2 } },
                periodMs: 1000, consecutiveFailuresBeforeAlerting: 1,
            }], investigation: { mode: 'inbox' } },
        }));
        await adoptProductionTelemetryHealthCheck({ ...input, credentials: input.collectorAccount.credentials,
            accepted: input.collectorAccount.accepted, setup });
        const saved = await vi.waitFor(async () => {
            const page = healthResultProjectionPageSchema.parse(await input.collectorAccount.accepted('action.invoke', {
                action: { pluginId: 'happier.machine.services', localId: 'health/results' }, input: {},
            }));
            const check = page.items.find(item => item.source?.sourceInstanceId === setup.sourceInstanceId)
                ?.projection.checks.find(item => item.checkId === checkId);
            return HealthCheckResultV1ProtocolSchema.parse(check?.result);
        }, { timeout: 30_000, interval: 1000 });
        expect(saved.status).toBe('unknown');
        expect(saved.cause?.observerMachineId).toBe(input.collectorMachineId);
        expect(saved.measurements).toMatchObject({ unit: 'USD', basis: 'catalog_estimate', completeness: 'unknown',
            reasons: expect.arrayContaining(['unpriced_calls']) });
        expect(saved.evidence.items).toEqual(expect.arrayContaining([expect.objectContaining({
            text: expect.stringContaining(`API-equivalent estimate in USD. Check Account ${input.collectorAccount.accountId} (its Usage prices)`),
        })]));
        expect(await readAgentAccounting()).toEqual(agentBefore);
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
