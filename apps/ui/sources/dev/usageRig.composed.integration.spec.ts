import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('react-native-mmkv', () => ({ MMKV: class { getString() { return undefined; } set() {} delete() {} } }));
import { db } from '../../../server/sources/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../../server/sources/app/api/testkit/sqliteFastify';
import { registerAccountUsageRoutes } from '../../../server/sources/app/api/routes/account/registerAccountUsageRoutes';
import { registerAccountEncryptionRoutes } from '../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { kvRoutes } from '../../../server/sources/app/api/routes/kv/kvRoutes';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageQueryAccountContext } from '../sync/api/account/usageQueryResource';
import type { AuthCredentials } from '../auth/storage/tokenStorage';
import { upsertServerProfile } from '../sync/domains/server/serverProfiles';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17, 12);
const VIEWS = [
    { id: 'Overview', widgets: ['usage_daily', 'usage_period_summary', 'usage_capacity', 'usage_projections', 'usage_coach', 'usage_efficiency', 'usage_rhythm'], breakdown: ['agent', 'model', 'source'] as const, includeActivity: true, includeInsights: true, includeModelTimeline: true, includeMessageStats: true },
    { id: 'Costs', widgets: ['usage_cost_facts', 'usage_daily', 'usage_breakdowns', 'usage_efficiency', 'usage_plan_fit', 'usage_outcomes'], breakdown: ['agent', 'model'] as const, metric: 'cost' as const, includeInsights: true, includeActivity: true },
    { id: 'Work', widgets: ['usage_project_ledger', 'usage_session_value', 'usage_outcomes'], breakdown: ['project', 'session'] as const, includeWorkEvidence: true },
    { id: 'Usage', widgets: ['usage_daily', 'usage_breakdowns', 'usage_efficiency', 'usage_flow'], breakdown: ['model', 'machine'] as const, includeActivity: true, includeModelTimeline: true },
    { id: 'Plans', widgets: ['usage_capacity', 'usage_projections', 'usage_resets', 'usage_plan_fit'], breakdown: ['model'] as const, includeActivity: true, includeInsights: true },
    { id: 'Coach', widgets: ['usage_coach'], breakdown: ['agent', 'model'] as const, includeInsights: true, includeSessionEvidence: true, includeCoach: true },
    { id: 'How you work', widgets: ['usage_rhythm', 'usage_human_loop', 'usage_parallel', 'usage_run_length', 'usage_planet', 'usage_recap'], breakdown: ['agent'] as const, includeActivity: true, includeSessionEvidence: true },
    { id: 'Sources', widgets: ['usage_sources', 'usage_source_coverage', 'usage_unpriced'], breakdown: ['source'] as const, includeActivity: true },
] as const;
const PERIODS = [
    { id: 'Week', relative: '7days' as const, days: 7 },
    { id: 'Month', relative: '30days' as const, days: 30 },
    { id: 'Year', relative: 'year' as const, days: 365 },
];

type RequestObservation = Readonly<{ path: string; status: number; bytes: number; elapsedMs: number }>;

function makeContext(accountId: string, request: UsageQueryAccountContext['request'], serverId: string): UsageQueryAccountContext {
    const credentials: AuthCredentials = { token: accountId };
    const lifetime = {
        scope: { serverId, accountId },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
    };
    // A scoped read transport keeps the real Resource owner on this exact test
    // lifetime while its read delegates to Fastify's injected HTTP boundary.
    return { credentials, accountLifetime: lifetime, request,
        readTransport: { scope: {}, serverId, key: `usage-rig:${accountId}`, read: async (path, init, _options, consume) => consume(await request(path, init)) } };
}

function seedRows(accountId: string, claudeSessionId: string, codexSessionId: string) {
    return Array.from({ length: 45_000 }, (_, index) => {
        const claude = index < 8_500;
        const day = claude ? index % 13 : index % 22;
        const observedAt = NOW - day * DAY - (index % 86_000) * 1_000;
        const inputTokens = 800 + (index % 101);
        const outputTokens = 200 + (index % 37);
        const totalTokens = inputTokens + outputTokens;
        return {
            accountId, sessionId: claude ? claudeSessionId : codexSessionId,
            observedAt: new Date(observedAt), agentId: claude ? 'claude' : 'codex',
            backendMode: claude ? 'anthropic' : 'openai', modelId: claude ? 'claude-3-5-sonnet' : 'gpt-5-mini',
            projectKey: claude ? 'project-claude' : 'project-codex', workspaceId: claude ? 'workspace-a' : 'workspace-b',
            machineId: claude ? 'machine-claude' : 'machine-codex', source: claude ? 'claude_sdk' : 'codex_app_server',
            scope: 'turn_delta', externalKey: `usage-rig-${index}`, isCumulative: false,
            inputTokens, outputTokens, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens,
            estimatedCostUsd: totalTokens / 100_000, costSource: 'pricing_estimate', currency: 'USD',
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
        };
    });
}

describe('Usage RIG: production-scale client/server data path', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-rig-', initAuth: false }); }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('runs every default view and reports all failures after the full matrix', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const claudeSession = await db.session.create({ data: { accountId: account.id, tag: 'usage-rig-claude', encryptionMode: 'plain', metadata: '{}' }, select: { id: true } });
        const codexSession = await db.session.create({ data: { accountId: account.id, tag: 'usage-rig-codex', encryptionMode: 'plain', metadata: '{}' }, select: { id: true } });
        const rows = seedRows(account.id, claudeSession.id, codexSession.id);
        for (let offset = 0; offset < rows.length; offset += 1_000) await db.usageEvent.createMany({ data: rows.slice(offset, offset + 1_000) });
        const observations: RequestObservation[] = [];
        const failures: Array<Record<string, unknown>> = [];
        const table: Array<Record<string, unknown>> = [];

        await withAuthenticatedTestApp(app => {
            registerAccountUsageRoutes(app);
            registerAccountEncryptionRoutes(app);
            kvRoutes(app);
        }, async app => {
            const { readUiUsageQueryBatch } = await import('../sync/api/account/usageQueryResource');
            const request: UsageQueryAccountContext['request'] = async (path, init) => {
                const started = performance.now();
                const bodyValue = init ? init.body : undefined;
                const body = bodyValue == null ? undefined : String(bodyValue);
                const response = await app.inject({ method: init?.method ?? 'GET', url: path,
                    headers: { 'x-test-user-id': account.id, ...(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}) },
                    ...(body === undefined ? {} : { payload: body }) });
                const elapsedMs = performance.now() - started;
                observations.push({ path, status: response.statusCode, bytes: Buffer.byteLength(response.body), elapsedMs });
                const headers = new Headers();
                for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, String(value));
                return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers });
            };
            const profile = await upsertServerProfile({ serverUrl: 'http://usage-rig.test', name: 'Usage RIG', source: 'manual' });
            const context = makeContext(account.id, request, profile.id);
            const cases = VIEWS.flatMap(view => PERIODS.map(period => ({ view, period, query: normalizeUsageQuery({
                    period: { relative: period.relative }, metric: view.metric ?? 'tokens', costBasis: 'auto',
                    includeSeries: false, includeInsights: false, includeActivity: false,
                    includeModelTimeline: false, includeMessageStats: false,
                    includeSessionEvidence: false, includeTranscriptEvidence: false,
                    includeCoach: false, includeWorkEvidence: false,
                    includeQuota: false, includeQuotaHistory: false,
                    breakdown: [...new Set([...view.breakdown, 'model'])],
                }) })));
            for (const view of VIEWS) {
                const viewCases = cases.filter(item => item.view.id === view.id);
                const batchStarted = performance.now();
                const batchBefore = observations.length;
                const batch = await readUiUsageQueryBatch(context, { queries: viewCases.map(item => item.query) });
                const batchElapsedMs = performance.now() - batchStarted;
                const batchRows = observations.slice(batchBefore);
                const analytics = batchRows.filter(row => row.path === '/v2/usage/query-batch' || row.path === '/v2/usage/query');
                if (analytics.length > 1) failures.push({ cell: `${view.id}/batch-acquisition`, error: `analytics-acquisition:${analytics.length}`, requests: batchRows });
                for (const [index, item] of viewCases.entries()) {
                    const { period } = item;
                    const cell = `${view.id}/${period.id}`;
                    try {
                        const slice = batch.results[index];
                        if (!slice || slice.pending || slice.errorCode) throw new Error(`settlement:${slice?.errorCode ?? 'pending'}`);
                        const accounting = slice.accounting;
                        if (!accounting) throw new Error('missing accounting response');
                        const decoded = UsageAnalyticsQueryResponseSchema.parse(accounting);
                        const renderedUnits = period.days * Math.max(1, view.breakdown.length + 1);
                        const budgetBytes = renderedUnits * 16_384 + 600_000;
                        const bytes = Buffer.byteLength(JSON.stringify(accounting));
                        if (bytes > budgetBytes) throw new Error(`decoded-bytes:${bytes}>${budgetBytes}`);
                        const models = decoded.breakdowns?.model ?? [];
                        if (!models.some(row => row.key === 'claude-3-5-sonnet') || !models.some(row => row.key === 'gpt-5-mini')) throw new Error('model-category-missing');
                        const total = decoded.totals.tokens.total ?? 0;
                        const grouped = models.reduce((sum, row) => sum + (row.tokens.total ?? 0), 0);
                        const other = Math.max(0, total - grouped);
                        if (grouped + other !== total) throw new Error('group-sum-conservation');
                        table.push({ view: view.id, period: period.id, renderedUnits, bytes, budgetBytes, requests: analytics.length, elapsedMs: Math.round(batchElapsedMs), events: decoded.totals.eventCount, models: models.map(row => row.key) });
                    } catch (error) {
                        failures.push({ cell, error: error instanceof Error ? error.message : String(error), requests: batchRows });
                    }
                }
                const reconnectBefore = observations.length;
                const warm = await readUiUsageQueryBatch(context, { queries: viewCases.map(item => item.query) });
                if (observations.length !== reconnectBefore) failures.push({ cell: `${view.id}/reconnect`, error: 'reconnect-refetched-settled-view', requests: observations.slice(reconnectBefore) });
                for (const [index, slice] of warm.results.entries()) if (slice?.pending || slice?.errorCode) failures.push({ cell: `${view.id}/reconnect/${viewCases[index]?.period.id}`, error: 'reconnect-not-settled' });
            }
            const refusal = await request('/v2/usage/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filters: { sessionIds: ['missing-usage-rig-session'] } }) });
            if (refusal.status !== 404) failures.push({ cell: 'typed-refusal/missing-session', error: `status:${refusal.status}` });
            const zero = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
            const zeroResponse = await app.inject({ method: 'POST', url: '/v2/usage/query', headers: { 'x-test-user-id': zero.id }, payload: { includeSeries: true } });
            if (zeroResponse.statusCode !== 200 || UsageAnalyticsQueryResponseSchema.parse(zeroResponse.json()).totals.eventCount !== 0) failures.push({ cell: 'zero-summary-account', error: `status:${zeroResponse.statusCode}` });
        });
        console.info(JSON.stringify({ command: './apps/stack/bin/hstack-exec --target=nl3 -- pnpm --dir apps/ui exec vitest run --config vitest.integration.config.ts sources/dev/usageRig.composed.integration.spec.ts', fixture: { usageEvents: rows.length, claudeEvents: 8_500, claudeDays: 13, codexEvents: 36_500, codexDays: 22, providers: ['anthropic', 'openai'], needsReauth: 'typed 404 refusal probe', zeroSummary: 'empty account probe' }, table, failures }));
        expect(failures, JSON.stringify({ table, failures })).toEqual([]);
    }, 600_000);
});
