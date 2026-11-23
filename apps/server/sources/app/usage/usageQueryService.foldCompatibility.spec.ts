import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUsageAnalyticsQueryRequestKey, UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsageMeasuredTokens } from '@happier-dev/protocol/usage/usageAggregation';
import type { AgentUsageObservedPayloadV1 } from '@happier-dev/protocol/runtime/agentUsageObservedPayloadV1';
import { describe, expect, it } from 'vitest';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery } from '@happier-dev/protocol/usage/usageCost';
import { foldScopedUsageContributions as foldHead } from './query/__fixtures__/headScopedUsageContributionFold';
import { bySubject, headBatchRow, headPopulation } from './query/__fixtures__/headUsagePopulation';
import { foldScopedUsageContributions } from './query/scopedUsageContributionFold';
import { normalizeUsageAnalyticsEvidenceRows, prepareUsageAnalyticsSnapshot, projectUsageAnalyticsPopulation } from './query/projectUsageAnalyticsPopulation';
import { orderRuntimeObservations, usageAccountingSubjectKey } from './query/resolveScopedUsageContributions';
import { toScopedUsageEventRow, toScopedUsageEvidenceRow, type ScopedUsageEvidenceRow } from './query/scopedUsageEventRow';
import { projectUsageAnalyticsBatch } from './query/readUsageAnalyticsBatch';
import { resolveCapturedUsageModelPriceCatalog } from './usageModelPriceCatalog';
import { projectUsageAnalytics, type UsageAnalyticsSnapshot } from './usageQueryService';
import { buildClaudeAssistantUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildAssistantObservation';
import { buildClaudeSdkResultUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildSdkResultObservation';
import { buildUsageEventIngestRequest } from '../../../../cli/src/usage/buildUsageEventIngestRequest';
import { toNativeAgentUsageObservation } from '../../../../cli/src/usage/nativeAgentUsageObservation';
import { buildCodexAppServerTokenCountObservationInput } from '../../../../../packages/plugins/codex/src/agent/usage/tokenCountMessage';
import { createCodexExternalSessionsContribution } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution';
import { createMuseEventProjection } from '../../../../../packages/plugins/muse/src/agent/events';
import { projectPiSessionStatsUsage } from '../../../../../packages/plugins/pi/src/agent/runtime/rpc/usage';
import { createOpenCodeServerRuntime } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/runtime';
import type { OpenCodeServerClient } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';
import { createContextFixture } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.managedServices.testkit';

type Query = ReturnType<typeof UsageAnalyticsQueryRequestSchema.parse>;
type Row = UsageAnalyticsSnapshot['rows'][number];
const dayMs = 86_400_000;
const start = Date.UTC(2026, 0, 1);
const catalogCapture = { fetchEnabled: false, stored: null };
const catalog = resolveCapturedUsageModelPriceCatalog(catalogCapture);

function observation(index: number, day: number, path: 'native' | 'runtime', total: number | null, estimate: number | null,
    extra: Partial<Row> = {}, accounting: Record<string, unknown> = {}): Row {
    const observedAt = new Date(start + day * dayMs + index);
    return {
        id: `obs-${index}`, sessionId: 'session', agentId: 'codex', observedAt, createdAt: observedAt,
        source: path, machineId: 'fixture-machine', backendMode: null, modelId: 'gpt-5.4-mini', projectKey: 'project',
        workspaceId: null, scope: 'session_cumulative', isCumulative: true, turnId: null, externalKey: null,
        requestCount: 1, teamCredentialResourceId: null, teamCredentialActorAccountId: null,
        teamCredentialExternalApiKeyId: null, teamCredentialSourceCredentialId: null, brokerMachineId: null,
        credentialDeliveryMode: null, contextUsedTokens: null, contextWindowTokens: null,
        inputTokens: total, totalTokens: total, outputTokens: total === null ? null : 0,
        cacheReadTokens: total === null ? null : 0, cacheWriteTokens: null, reasoningTokens: null,
        currency: 'USD', billingContext: null, costSource: 'pricing_estimate',
        reportedCostUsd: null, estimatedCostUsd: estimate, invoiceCostUsd: null, costBreakdown: null,
        metadata: { usageAccounting: { path, status: 'available', historyComplete: true, ...accounting } },
        ...extra,
    };
}

function keylessStreams() {
    const rawSubject = { nativeSessionId: 'fixture-thread' };
    const exact = { scope: 'turn_delta', isCumulative: false };
    const explicit = [
        ['measured zero', [observation(1, 0, 'runtime', 0, 0)]],
        ['cost only', [observation(1, 0, 'runtime', null, 0.2)]],
        ['repriced absolute counter', [observation(1, 0, 'runtime', 100, 0.01), observation(2, 1, 'runtime', 100, 0.03)]],
        ['legacy raw-id with Session membership', [
            observation(1, 0, 'native', 100, 0.01, { sessionId: null }, rawSubject),
            observation(2, 1, 'runtime', 13, 0.02, exact, rawSubject),
            observation(3, 2, 'runtime', 113, 0.03, {}, rawSubject),
        ]],
    ] as const;
    const seeded = [7, 21, 42, 125, 212, 421, 443, 919, 2027].map(seed => {
        let state = seed;
        const pick = (max: number) => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return (state >>> 16) % max;
        };
        let total = 0;
        const rows = Array.from({ length: 5 }, (_, day) => {
            const amount = 4 + pick(45);
            const isExact = pick(3) === 0;
            const reset = pick(6) === 0;
            total = reset ? amount : total + amount;
            const path = seed % 2 === 0 ? 'runtime' : day % 2 === 0 ? 'native' : 'runtime';
            return observation(day + 1, day, path, isExact ? amount : total, (1 + pick(9)) / 100, {
                modelId: day % 2 === 0 ? 'gpt-5.4' : 'gpt-5.4-mini',
                cacheReadTokens: pick(2) ? pick(amount) : null, outputTokens: pick(2) ? pick(amount) : null,
                reportedCostUsd: pick(2) ? pick(7) / 100 : null,
                costBreakdown: JSON.stringify({ cacheSavingsUsd: pick(7) / 100 }),
                ...(isExact ? exact : {}),
            }, { ...rawSubject, ...(isExact ? { inferenceId: `response-${day % 3}` } : {}) });
        });
        return [`seed ${seed}`, rows] as const;
    });
    return [...explicit, ...seeded];
}

function producerRow(index: number, observedAt: number, agentId: string,
    input: Parameters<typeof buildUsageEventIngestRequest>[0]['observation'],
    accounting: Record<string, unknown>, path: 'runtime' | 'native' = 'runtime', threadKey = 'b'.repeat(64)): Row {
    const request = buildUsageEventIngestRequest({ sessionId: 'session', observedAt, observation: input });
    if (!request) throw new Error(`Invalid ${agentId} producer fixture`);
    const { tokens, cost, context } = request;
    return {
        ...observation(index, 0, path, null, null),
        observedAt: new Date(observedAt), createdAt: new Date(observedAt),
        agentId, source: request.source, modelId: request.modelId ?? null,
        scope: request.scope, isCumulative: request.isCumulative, turnId: request.turnId ?? null,
        inputTokens: tokens.input, outputTokens: tokens.output, totalTokens: tokens.total,
        cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite, reasoningTokens: tokens.reasoning,
        contextUsedTokens: context?.usedTokens ?? null, contextWindowTokens: context?.windowTokens ?? null,
        reportedCostUsd: cost.reportedUsd, estimatedCostUsd: cost.estimatedUsd, invoiceCostUsd: cost.invoiceUsd ?? null,
        currency: cost.currency, billingContext: cost.billingContext ?? null, costSource: cost.costSource ?? null,
        costBreakdown: JSON.stringify(cost.breakdown),
        metadata: { usageAccounting: { path, status: 'available', ...accounting, nativeSessionKey: threadKey } },
    };
}

function claudeRuntimeStream(assistantDay: number, finalDay: number, tokens = 12, finalTokens = tokens, finalOutput = 2): Row[] {
    const modelId = 'claude-haiku-4-5';
    const assistant = buildClaudeAssistantUsageObservation({ modelId, usage: {
        input_tokens: tokens - 2, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    } });
    const result = buildClaudeSdkResultUsageObservation({ modelId, result: {
        type: 'result', subtype: 'success', total_cost_usd: 1.25,
        modelUsage: { [modelId]: { inputTokens: finalTokens - finalOutput, outputTokens: finalOutput, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    } });
    if (!assistant || !result) throw new Error('Expected Claude assistant and SDK result');
    return [producerRow(1, start + assistantDay * dayMs + 1, 'claude', assistant, { inferenceId: 'a'.repeat(64) }),
        producerRow(2, start + finalDay * dayMs + 2, 'claude', result, {})];
}

function runtimeRow(index: number, observedAt: number, agentId: string, event: AgentUsageObservedPayloadV1,
    threadKey?: string): Row {
    const { inferenceId, inputIncludesCache, outputIncludesReasoning, historyComplete } = event.accounting ?? {};
    return producerRow(index, observedAt, agentId, toNativeAgentUsageObservation(event, agentId), {
        ...(inferenceId ? { inferenceId: String(index).padStart(64, '0') } : {}),
        inputIncludesCache, outputIncludesReasoning, historyComplete,
        ...(threadKey ? { nativeSessionId: threadKey } : {}),
    }, 'runtime', threadKey);
}

async function openCodeRuntimeRows(): Promise<Row[]> {
    const client = {
        sessionUpdatePermissions: async () => undefined,
        agentsList: async () => [],
        sessionReadAgent: async () => null,
        sessionMessages: async () => [],
        subscribeGlobalEvents: async ({ signal }) => new Promise<void>(resolve =>
            signal.addEventListener('abort', () => resolve(), { once: true })),
    } satisfies Partial<OpenCodeServerClient>;
    const controller = createOpenCodeServerRuntime({
        ctx: createContextFixture({
            managedServerBaseUrl: 'http://opencode.test',
            systemToolResolveError: new Error('Unexpected provider launch'),
        }),
        directory: tmpdir(), happierSessionId: 'session', providerModelId: 'gpt-5.4',
        // This native HTTP boundary supplies only the resume and event methods exercised here.
        client: client as unknown as OpenCodeServerClient,
        mcpRegistration: Promise.resolve({ requiredHappier: { status: 'ready' }, registeredServers: [] }),
        mcpProjection: { registrations: [], requiredHappierServerName: null, requiredHappierConfigurationPresent: false },
    });
    const rows: Row[] = [];
    const unsubscribe = controller.subscribeRuntimeEvents(event => {
        if (event.kind === 'usage-observed') rows.push(runtimeRow(rows.length + 1, event.emittedAtMs, 'opencode', event));
    });
    try {
        await controller.openSession({ kind: 'resume', providerSessionId: 'fixture-opencode-thread' });
        for (const day of [0, 1]) {
            const completed = start + day * dayMs + 1000;
            await controller.handleProviderEvent({ payload: { type: 'message.updated', properties: { info: {
                id: `fixture-response-${day}`, sessionID: 'fixture-opencode-thread', role: 'assistant', finish: 'stop',
                time: { created: completed - 1, completed }, modelID: 'gpt-5.4',
                tokens: { input: 10 + day, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 12 + day },
                cost: 0.002,
            } } } });
        }
        if (rows.length !== 2) throw new Error('Expected two OpenCode runtime observations');
        return rows;
    } finally {
        unsubscribe();
        await controller.resetOrDisposeRuntime();
    }
}

async function museRuntimeRows(): Promise<Row[]> {
    const projection = createMuseEventProjection({ sessionId: 'session' });
    const rows: Row[] = [];
    let observedAt = start + 1;
    projection.watch(event => {
        if (event.kind !== 'usage-observed') return;
        const threadKey = event.scope === 'turn_delta' ? 'b'.repeat(64) : 'c'.repeat(64);
        rows.push(runtimeRow(rows.length + 1, observedAt, 'muse', event, threadKey));
    });
    try {
        for (const day of [0, 1]) {
            observedAt = start + day * dayMs + 1;
            projection.observe({ method: 'session/tokenUsage', params: { sessionId: 'fixture-muse-main',
                viewCursor: `fixture-response-${day}`, promptTokens: 10, totalTokens: 12,
                usage: { outputTokens: 2, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
        }
        observedAt++;
        await projection.observe({ method: 'item/updated', params: { item: { kind: 'subagent', itemId: 'fixture-item',
            subagentId: 'fixture-run', childSessionId: 'fixture-child', status: 'completed',
            usage: { inputTokens: 20, outputTokens: 4, reasoningTokens: 0 } } } });
        if (rows.length !== 3) throw new Error('Expected two Muse main observations and one child snapshot');
        return rows;
    } finally { projection.dispose(); }
}

async function codexNativeRows(): Promise<Row[]> {
    const homePath = await mkdtemp(join(tmpdir(), 'happier-usage-compatibility-'));
    try {
        const directory = join(homePath, 'sessions');
        await mkdir(directory);
        const records = [
            { type: 'session_meta', payload: { id: 'fixture-codex-native' }, timestamp: new Date(start).toISOString() },
            { type: 'turn_context', payload: { model: 'gpt-5.4' }, timestamp: new Date(start + 1).toISOString() },
            ...[100, 110].map((counter, day) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
                total_token_usage: { input_tokens: counter, output_tokens: 2, total_tokens: counter + 2 },
            } }, timestamp: new Date(start + day * dayMs + 2).toISOString() })),
        ];
        await writeFile(join(directory, 'rollout.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
        const unavailable = async () => { throw new Error('Codex accounting fixture uses local files'); };
        const capture = await createCodexExternalSessionsContribution({ env: { CODEX_HOME: homePath } }).readAccounting?.({
            source: { kind: 'codexHome', home: 'user', homePath }, signal: new AbortController().signal,
            managedEndpointRead: unavailable,
            exec: {
                agentCli: { checkReadiness: unavailable }, systemTools: { resolve: unavailable },
                prepareNativeSocketDirectory: unavailable, withSpawnAdmission: unavailable,
                run: unavailable, spawn: unavailable, clients: { spawn: unavailable, connectJsonRpc: unavailable },
            },
            ripgrep: { run: unavailable },
        });
        if (!capture?.ok || capture.value.outcome !== 'advanced' || capture.value.observations.length !== 2) {
            throw new Error('Expected two native Codex counter observations');
        }
        return capture.value.observations.map((entry, index) => {
            const row = producerRow(index + 1, entry.observedAt, 'codex', entry.observation, entry.accounting ?? {}, 'native');
            return { ...row, metadata: { ...row.metadata as object, accountingSubject: {
                kind: 'native', machineId: 'fixture-machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                sourceRootKey: 'fixture-root', nativeSessionKey: 'fixture-native', linkedSessionId: 'session',
            } } };
        });
    } finally { await rm(homePath, { recursive: true, force: true }); }
}

function runtimeCounters(provider: 'pi' | 'codex'): Row[] {
    return [100, 110].map((total, day) => {
        const observedAt = start + day * dayMs + 1;
        const observationId = `fixture-${provider}-${day}`;
        if (provider === 'pi') {
            const event = projectPiSessionStatsUsage({ sessionId: 'session', observationId, observedAtMs: observedAt,
                stats: { sessionId: 'fixture-pi-thread', tokens: { input: total - 10, output: 10, total }, cost: total / 10000 } });
            if (!event) throw new Error('Expected Pi runtime counters');
            expect(event.observationId).toBe(observationId);
            return runtimeRow(day + 1, observedAt, provider, event);
        }
        const counters = buildCodexAppServerTokenCountObservationInput({ observedAtMs: observedAt, modelId: 'gpt-5.4',
            notificationParams: { tokenUsage: { total: { inputTokens: total - 10, outputTokens: 10, totalTokens: total } } } })
            ?.runtimeObservation;
        if (!counters) throw new Error('Expected Codex runtime counters');
        return runtimeRow(day + 1, observedAt, provider, { ...counters, observationId });
    });
}

const modes = [
    ['personal', {}],
    ['public', { population: 'public_eligible_personal' }],
    ['session', { filters: { sessionIds: ['session'] } }],
    ['execution', { filters: { execution: 'happier' } }],
    ['public + execution', { population: 'public_eligible_personal', filters: { execution: 'happier' } }],
] as const;

function queries(from: number, to: number): Query[] {
    return modes.map(([, fields]) => UsageAnalyticsQueryRequestSchema.parse({
        dateRange: { startMs: start + from * dayMs, endMs: start + to * dayMs },
        granularity: 'day', timeZoneOffsetMinutes: 0, includeSeries: true, includeActivity: true, includeModelTimeline: true,
        breakdowns: ['source', 'model', 'session'], ...fields,
    }));
}

function snapshot(rows: readonly Row[]): UsageAnalyticsSnapshot {
    return { rows: [...rows], legacyReports: [], priceCatalog: catalogCapture, messageCountsBySession: undefined };
}

const batch = async (rows: readonly Row[], requests: readonly Query[], compact: boolean) => {
    const captured = snapshot(rows);
    return projectUsageAnalyticsBatch({ priceCatalog: catalogCapture,
        snapshots: new Map(requests.map(query => [getUsageAnalyticsQueryRequestKey(query), captured])) },
        requests, !compact, compact);
};

async function expectHeadBytes(label: string, rows: readonly Row[]) {
    const scoped = rows.map(toScopedUsageEventRow);
    const ranks = new Map(orderRuntimeObservations(scoped).map((row, index) => [row.id, index]));
    for (const group of bySubject(scoped).values()) {
        expect(JSON.stringify(foldScopedUsageContributions(group, new Map(ranks))), label)
            .toBe(JSON.stringify(foldHead(group, new Map(ranks))));
    }
    const end = (rows.at(-1)!.observedAt.getTime() - start) / dayMs;
    const requests = [...queries(0, Math.ceil(end)), ...queries(Math.floor(end), Math.ceil(end))];
    const rich = await batch(rows, requests, false);
    const compact = await batch(rows, requests, true);
    for (const [index, request] of requests.entries()) {
        const context = `${label}, ${modes[index % modes.length]![0]}, window ${Math.floor(index / modes.length)}`;
        const base = projectUsageAnalytics(snapshot(rows), request, catalog, headPopulation(rows, request));
        const actual = projectUsageAnalytics(snapshot(rows), request, catalog);
        expect(JSON.stringify(actual), context).toBe(JSON.stringify(base));
        expect(JSON.stringify(rich.results[index]), `${context} rich`).toBe(JSON.stringify(await headBatchRow(snapshot(rows), catalog, request, false)));
        expect(JSON.stringify(compact.results[index]), `${context} compact`).toBe(JSON.stringify(await headBatchRow(snapshot(rows), catalog, request, true)));
    }
}

// Date-row ordering from the parent of 19409b01c98, before the tie shortcut.
function headRuntimeOrder<Row extends ScopedUsageEvidenceRow>(rows: readonly Row[]): Row[] {
    const compareChronologically = (left: Row, right: Row) => left.observedAt.getTime() - right.observedAt.getTime()
        || left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
    const ordered = [...rows].sort(compareChronologically);
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (end < ordered.length && ordered[end]!.observedAt.getTime() === ordered[start]!.observedAt.getTime()) end++;
        const streams = new Map<string, { slots: number[]; rows: Array<{ row: Row; sequence: number }> }>();
        for (let index = start; index < end; index++) {
            const row = ordered[index]!;
            const accounting = row.accountingEvidence?.accounting;
            const order = accounting?.path === 'runtime' ? accounting.runtimeEventOrder : undefined;
            if (!order) continue;
            const stream = streams.get(order.runtimeIncarnationId) ?? { slots: [], rows: [] };
            stream.slots.push(index);
            stream.rows.push({ row, sequence: order.sequence });
            streams.set(order.runtimeIncarnationId, stream);
        }
        for (const stream of streams.values()) {
            stream.rows.sort((left, right) => left.sequence - right.sequence || compareChronologically(left.row, right.row));
            stream.slots.forEach((slot, index) => { ordered[slot] = stream.rows[index]!.row; });
        }
        start = end;
    }
    return ordered;
}

describe('accounting fold compatibility', () => {
    it('preserves HEAD replay and full batch delivery for a runtime tie and linked legacy report at the period boundary', async () => {
        const boundary = start + dayMs;
        const tied = (row: Row, id: string, createdOffset: number, sequence?: number): Row => ({
            ...row, id, observedAt: new Date(boundary), createdAt: new Date(boundary + createdOffset),
            ...(sequence === undefined ? { sessionId: 'claude-session' } : {}),
            metadata: JSON.stringify({ ...(row.metadata as object), usageAccounting: {
                    ...(row.metadata as { usageAccounting: object }).usageAccounting,
                    ...(sequence === undefined ? { nativeSessionKey: 'c'.repeat(64) }
                        : { runtimeEventOrder: { runtimeIncarnationId: 'codex-runtime', sequence } }),
            } }),
        });
        const [baseline, next] = runtimeCounters('codex');
        const codexFirst = tied(next!, 'codex-sequence-1', 3, 1);
        const codexSecond = tied({ ...next!, inputTokens: 120, totalTokens: 130 }, 'codex-sequence-2', 1, 2);
        const claudeFinal = tied(claudeRuntimeStream(0, 1)[1]!, 'claude-final', 2);
        const linkedPrior = observation(7, 0, 'runtime', 7, 0.01, { id: 'linked-prior', agentId: 'pi' });
        expect([claudeFinal.scope, codexFirst.scope, codexSecond.scope]).toEqual(['session_final', 'session_cumulative', 'session_cumulative']);
        const captured: UsageAnalyticsSnapshot = {
            ...snapshot([codexSecond, claudeFinal, codexFirst, linkedPrior, { ...baseline!, id: 'codex-prior' }]),
            legacyReports: [{ id: 'linked', sessionId: 'session', key: 'retained',
                data: { tokens: { total: 1000 }, cost: { total: 10 } },
                createdAt: new Date(boundary - 1), updatedAt: new Date(boundary) }],
        };
        const input = UsageAnalyticsQueryBatchRequestSchema.parse({
            queries: [queries(0, 1)[0], queries(1, 2)[0]],
            contributionQueries: [queries(0, 1)[0], queries(1, 2)[0]],
        });
        const reference = new Map<string, UsageAnalyticsSnapshot>();
        for (const query of input.queries) {
            const current = prepareUsageAnalyticsSnapshot(captured, query);
            const { startMs, endMs } = query.dateRange ?? {};
            if (startMs === undefined || endMs === undefined) throw new Error('Expected a bounded parity fixture query');
            const reports = captured.legacyReports.filter(report => report.updatedAt.getTime() < endMs);
            const rows = captured.rows.filter(row => row.observedAt.getTime() < endMs);
            const evidenceRows = normalizeUsageAnalyticsEvidenceRows(rows.map(toScopedUsageEvidenceRow), reports);
            const ordered = headRuntimeOrder(evidenceRows);
            const actualOrder = [...current.replayContext!.ranks.keys()];
            expect(actualOrder).toEqual(ordered.map(row => row.id));
            expect(actualOrder).toEqual(startMs === start ? ['codex-prior', linkedPrior.id]
                : ['codex-prior', linkedPrior.id, 'legacy-report:linked', codexFirst.id, claudeFinal.id, codexSecond.id]);

            const ranks = new Map(ordered.map((row, index) => [row.id, index]));
            const subjects = new Map(evidenceRows.map(row => [row.id, usageAccountingSubjectKey(row)]));
            const selectedSubjects = new Set(evidenceRows.filter(row => row.observedAt.getTime() >= startMs)
                .map(row => subjects.get(row.id)!));
            const legacySessions = new Set(evidenceRows.flatMap(row => row.sessionId && row.source === 'legacy_usage_report'
                && selectedSubjects.has(subjects.get(row.id)!) ? [row.sessionId] : []));
            for (const row of evidenceRows) {
                if (row.sessionId && legacySessions.has(row.sessionId)) selectedSubjects.add(subjects.get(row.id)!);
            }
            const selectedEventIds = new Set(evidenceRows.filter(row => selectedSubjects.has(subjects.get(row.id)!)).map(row => row.id));
            expect([...current.replayContext!.selectedEventIds]).toEqual([...selectedEventIds]);
            expect(current.replayContext!.selectedEventIds.has(linkedPrior.id)).toBe(true);
            if (startMs === boundary) {
                const residual = projectUsageAnalyticsPopulation(captured, query).totalContributions
                    .find(row => row.source === 'legacy_usage_report');
                expect(residual?.tokens.total).toBe(863);
            }
            for (const group of bySubject(rows.map(toScopedUsageEventRow)).values()) {
                expect(JSON.stringify(foldScopedUsageContributions(group, new Map(current.replayContext!.ranks))))
                    .toBe(JSON.stringify(foldHead(group, new Map(ranks))));
            }
            const preparedQueryKey = getUsageAnalyticsQueryRequestKey(query);
            reference.set(preparedQueryKey, { ...captured, rows: rows.filter(row => selectedEventIds.has(row.id)),
                legacyReports: reports, evidenceRows, replayContext: { ranks, subjects, selectedEventIds }, preparedQueryKey });
        }
        const deliver = async (snapshots: Map<string, UsageAnalyticsSnapshot>) => {
            const projected = await projectUsageAnalyticsBatch({ priceCatalog: catalogCapture, snapshots },
                input.queries, true, true, undefined, input);
            return collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery(projected, input, false));
        };
        const actual = await deliver(new Map(input.queries.map(query => [getUsageAnalyticsQueryRequestKey(query), { ...captured }])));
        expect(actual.results.every(result => 'value' in result && result.value.coverage)).toBe(true);
        expect(actual.contributionPages?.map(page => page.rows.length)).toEqual([2, expect.any(Number)]);
        expect(actual.contributionPages?.[1]?.rows.length).toBeGreaterThan(1);
        expect(JSON.stringify(actual)).toBe(JSON.stringify(await deliver(reference)));
    });

    it('preserves HEAD fold and scalar, rich and compact read bytes for keyless streams in every read mode', async () => {
        for (const [label, rows] of keylessStreams()) {
            await expectHeadBytes(label, rows);
        }
    });

    it('preserves Claude invocation-wide cost scope across midnight', async () => {
        const rows = claudeRuntimeStream(0, 1);
        const resultDay = projectUsageAnalytics(snapshot(rows), queries(1, 2)[0]!, catalog);
        expect(resultDay.costFacts).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 1.25 }));
        expect(resultDay.costPresentation?.effectiveUsd ?? null).toBeNull();
        expect(resultDay.totals.tokens.total).toBeNull();
        await expectHeadBytes('Claude across midnight', rows);
    });

    it.each([
        ['Claude within one day', () => claudeRuntimeStream(1, 1)],
        ['OpenCode', openCodeRuntimeRows],
        ['Pi', () => runtimeCounters('pi')],
        ['Muse main and child', museRuntimeRows],
        ['Codex runtime-only', () => runtimeCounters('codex')],
        ['Codex native-only', codexNativeRows],
    ] as const)('preserves HEAD scalar, rich and compact bytes for the shipped %s single-source shape', async (label, readRows) => {
        await expectHeadBytes(label, await readRows());
    });

    it.each([12, 15])('carries the linked Claude reported total after a replay of %i tokens', amount => {
        const [assistant, final] = claudeRuntimeStream(amount === 12 ? 0 : 1, 1, amount);
        const [original] = claudeRuntimeStream(0, 0);
        const capturedAssistant = { ...original!, id: 'captured-assistant',
            metadata: { usageAccounting: { path: 'native', status: 'available', inferenceId: 'a'.repeat(64), nativeSessionKey: 'b'.repeat(64) } } };
        const rows = [assistant!, capturedAssistant, final!];
        const whole = projectUsageAnalytics(snapshot(rows), queries(0, 2)[0]!, catalog);
        const resultDay = projectUsageAnalytics(snapshot(rows), queries(1, 2)[0]!, catalog);
        expect(whole.totals.tokens.total).toBe(amount);
        expect(whole.costPresentation?.effectiveUsd).toBe(1.25);
        expect(resultDay.costFacts).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 1.25 }));
        expect(resultDay.costPresentation?.effectiveUsd ?? null).toBeNull();
        expect(resultDay.totals.tokens.total).toBe(amount === 12 ? null : 3);
    });

    it.each([
        ['covered by both sources', 20, 0, false, [20, null, 20]],
        ['larger than both exact facts', 24, 0, false, [20, 4, 24]],
        ['confirmed by later native observation', 20, 0, true, [8, 12, 20]],
        ['scoped to an earlier native contribution', 20, 1, false, [12, 8, 20]],
    ] as const)('reconciles the mixed Claude final %s in every read mode', async (label, finalTokens, assistantDay, late, truth) => {
        const [assistant, final] = claudeRuntimeStream(assistantDay, 1, 8, finalTokens, 4);
        const [original] = claudeRuntimeStream(0, 0, 12);
        const capturedAssistant = {
            ...original!, id: 'captured-assistant',
            // A native record at the final's timestamp can arrive after the
            // runtime result. Equal timestamps do not prove it is new work.
            ...(late ? { observedAt: final!.observedAt, createdAt: new Date(final!.createdAt.getTime() + 1) } : {}),
            source: 'native',
            metadata: {
                accountingSubject: { kind: 'native', machineId: 'fixture-machine', agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    sourceRootKey: 'fixture-root', nativeSessionKey: 'fixture-native', linkedSessionId: 'session' },
                usageAccounting: { path: 'native', status: 'available', inferenceId: 'c'.repeat(64), nativeSessionKey: 'b'.repeat(64) },
            },
        };
        const rows = [assistant!, final!, capturedAssistant];
        const requests = [...queries(0, 1), ...queries(1, 2), ...queries(0, 2)];
        const rich = await batch(rows, requests, false);
        const compact = await batch(rows, requests, true);
        for (const [index, request] of requests.entries()) {
            const window = Math.floor(index / modes.length);
            const context = `${label}, ${modes[index % modes.length]![0]}, window ${window}`;
            const scalar = projectUsageAnalytics(snapshot(rows), request, catalog);
            const richResult = rich.results[index]!;
            const compactResult = compact.results[index]!;
            if (!('value' in richResult) || !('value' in compactResult)) throw new Error(`Failed ${context}`);
            for (const result of [scalar, richResult.value, compactResult.value]) {
                expect(result.totals.tokens.total, context).toBe(truth[window]);
                if (window === 1 && finalTokens === 20 && !late) {
                    expect(result.coverage?.reasons, context).not.toContain('missing_baseline');
                }
            }
        }
        const finalDay = projectUsageAnalytics(snapshot(rows), queries(1, 2)[0]!, catalog);
        expect(finalDay.costFacts).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 1.25 }));
        expect(finalDay.costPresentation?.effectiveUsd ?? null).toBeNull();
        expect(projectUsageAnalytics(snapshot(rows), queries(0, 2)[0]!, catalog).costPresentation?.effectiveUsd).toBe(1.25);
    });

    it.each([
        ['equal measured checkpoints', undefined, true, [100, 0], [20, 40]],
        ['growing measured checkpoints', { input: 130, cache: 30 }, true, [100, 0, 30], [20, 40, 0]],
        ['restarting runtime counter', { input: 30, cache: 10, reset: true }, true, [100, 0, 30], [20, 40, 10]],
        ['declared native with undeclared runtime parts', undefined, false, [100, 30], [20, 40]],
    ] as const)('counts measured levels and preserves raw cache evidence for %s', async (label, third, runtimeIncludesCache, increments, cacheReads) => {
        const subject = { kind: 'native', machineId: 'fixture-machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
            sourceRootKey: 'fixture-root', nativeSessionKey: 'fixture-native', linkedSessionId: 'session' };
        const checkpoint = (day: number, path: 'native' | 'runtime', input: number, cache: number, includesCache: boolean, epoch: string) =>
            observation(day + 1, day, path, null, label === 'growing measured checkpoints' ? input / 1000 : null, {
                inputTokens: input, cacheReadTokens: cache,
                metadata: { accountingSubject: subject, usageAccounting: { path, status: 'available', historyComplete: true,
                    nativeSessionKey: 'a'.repeat(64), inputIncludesCache: includesCache, counterEpoch: epoch } },
            });
        const rows = [checkpoint(0, 'native', 100, 20, true, 'native-first'),
            checkpoint(1, 'runtime', runtimeIncludesCache ? 100 : 70, 60, runtimeIncludesCache, 'runtime-first')];
        if (third) rows.push(checkpoint(2, 'runtime', third.input, third.cache, true,
            'reset' in third ? 'runtime-second' : 'runtime-first'));

        const requests = [...increments.flatMap((_, day) => queries(day, day + 1)), ...queries(0, rows.length)];
        const rich = await batch(rows, requests, false);
        const compact = await batch(rows, requests, true);
        for (const [index, request] of requests.entries()) {
            const day = Math.floor(index / modes.length);
            const context = `${label}, ${modes[index % modes.length]![0]}, window ${day}`;
            const scalar = projectUsageAnalytics(snapshot(rows), request, catalog);
            const richResult = rich.results[index]!;
            const compactResult = compact.results[index]!;
            if (!('value' in richResult) || !('value' in compactResult)) throw new Error(`Failed ${context}`);
            for (const result of [scalar, richResult.value, compactResult.value]) {
                const tokens = result.totals.tokens;
                expect(resolveUsageMeasuredTokens(tokens), context).toEqual({
                    total: increments[day] ?? increments.map(Number).reduce((sum, value) => sum + value, 0),
                    fromParts: true,
                });
                expect(tokens.total, context).toBeNull();
                expect(tokens.cacheRead, context).toBe(cacheReads[day] ?? cacheReads.map(Number).reduce((sum, value) => sum + value, 0));
                if (label === 'growing measured checkpoints') {
                    // Pricing follows measured source increments, even when a new raw facet adds no tokens.
                    expect(result.totals.cost.estimatedUsd, context).toBe([0.1, null, 0.03, 0.13][day]);
                }
                expect(result.coverage?.reasons, context).not.toContain('counter_discontinuity');
            }
        }
    });

    it('keeps the reviewed bytes for undeclared mixed checkpoints', async () => {
        const subject = { kind: 'native', machineId: 'fixture-machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
            sourceRootKey: 'fixture-root', nativeSessionKey: 'fixture-native', linkedSessionId: 'session' };
        const checkpoint = (day: number, path: 'native' | 'runtime', total: number | null, input: number, output: number,
            cache: number, cost: number) => observation(day + 1, day, path, total, cost, {
                inputTokens: input, outputTokens: output, cacheReadTokens: cache,
                metadata: { accountingSubject: subject, usageAccounting: { path, status: 'available', historyComplete: true,
                    nativeSessionKey: 'a'.repeat(64) } },
            });
        const sparse = [checkpoint(0, 'native', null, 100, 0, 20, 0.1), checkpoint(1, 'runtime', null, 100, 0, 60, 0.15)];
        const explicit = [checkpoint(0, 'runtime', 100, 70, 30, 10, 0.1), checkpoint(1, 'native', 135, 90, 45, 10, 0.135)];
        const requests = [...queries(0, 1), ...queries(1, 2), ...queries(0, 2)];
        const bytes = createHash('sha256');
        for (const rows of [sparse, explicit]) {
            const scalar = requests.map(query => projectUsageAnalytics(snapshot(rows), query, catalog));
            const rich = await batch(rows, requests, false);
            const compact = await batch(rows, requests, true);
            bytes.update(JSON.stringify([scalar, rich.results, compact.results]));
        }
        // Round 17 before normalizing overlapping parts in the mixed fold.
        expect(bytes.digest('hex')).toBe('bf9a4cbadfdc27f00872ad0bce138dda9f940d1ed4265086419a833779573551');
    });

    it('retains HEAD source witnesses and range completeness across keyed replay histories in every mode', async () => {
        const subject = { kind: 'native', machineId: 'fixture-machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
            sourceRootKey: 'fixture-root', nativeSessionKey: 'fixture-native', linkedSessionId: 'session' };
        const exact = { scope: 'turn_delta', isCumulative: false };
        const exactRow = (index: number, day: number, path: 'native' | 'runtime', amount: number, response: number) => ({
            ...observation(index, day, path, amount, 0.01, exact),
            metadata: { accountingSubject: subject, usageAccounting: { path, status: 'available', historyComplete: true,
                inferenceId: `response-${response}`, nativeSessionKey: 'a'.repeat(64) } },
        });
        const example = [exactRow(1, 0, 'native', 12, 1), exactRow(2, 1, 'runtime', 12, 1)];
        const cases = [{ seed: 0, rows: example, truth: [12, 0] }, ...[7, 21, 42, 125, 212, 421, 443, 919, 2027].map(seed => {
            const amounts = Array.from({ length: 3 }, (_, index) => 1 + (Math.imul(seed, index + 1) % 17));
            const rows = amounts.flatMap((amount, index) => {
                const first = (seed + index) % 2 ? 'native' : 'runtime';
                return [exactRow(index * 2 + 1, index * 2, first, amount, index),
                    exactRow(index * 2 + 2, index * 2 + 1, first === 'native' ? 'runtime' : 'native', amount, index)];
            });
            return { seed, rows, truth: amounts.flatMap(amount => [amount, 0]) };
        })];
        for (const { seed, rows, truth } of cases) {
            const requests = truth.flatMap((_, day) => queries(day, day + 1));
            const rich = await batch(rows, requests, false);
            const compact = await batch(rows, requests, true);
            for (const [index, request] of requests.entries()) {
                const actual = projectUsageAnalytics(snapshot(rows), request, catalog);
                const expected = projectUsageAnalytics(snapshot(rows), request, catalog, headPopulation(rows, request));
                const day = Math.floor(index / modes.length);
                const label = `seed ${seed}, ${modes[index % modes.length]![0]}, day ${day}`;
                const richResult = rich.results[index]!;
                const compactResult = compact.results[index]!;
                if (!('value' in richResult) || !('value' in compactResult)) throw new Error(`Failed ${label}`);
                const oldAvailable = expected.coverage?.sources.filter(source => source.status === 'available').map(source => source.path);
                for (const result of [actual, richResult.value, compactResult.value]) {
                    const available = result.coverage?.sources.filter(source => source.status === 'available').map(source => source.path);
                    expect(available, label).toEqual(expect.arrayContaining(oldAvailable ?? []));
                    // HEAD can lack a witness on the first day when it prefers a later replay.
                    if (expected.coverage?.range.complete) expect(result.coverage?.range.complete, label).toBe(true);
                    expect(available, label).toContain(rows[day]!.source);
                    expect(result.totals.tokens.total, label).toBe(truth[day]);
                    expect(result.totals.eventCount, label).toBe(truth[day] ? 1 : 0);
                }
            }
        }
        const rows = example;
        const requests = [...queries(0, 1), ...queries(1, 2)];
        const privateRuntime = { ...rows[1]!, teamCredentialResourceId: 'fixture-team-credential' };
        const population = projectUsageAnalyticsPopulation(snapshot([rows[0]!, privateRuntime]), requests[modes.length + 1]!);
        expect(population.evidenceRows).toEqual([]);
    });
});
