import { describe, expect, it } from 'vitest';
import { evaluateUsageCoach } from './evaluateUsageCoach.js';
import { UsageCoachFindingSchema, type UsageCoachEvaluationInput } from './coachFinding.js';
import { USAGE_COACH_DETECTOR_IDS } from './coachDetectorIds.js';
import { UsageAnalyticsQueryResponseSchema } from '../usageAnalyticsContracts.js';
import { UsageModelPriceCatalogSchema } from '../usageModelPriceCatalog.js';
import { resolveUsageHowYouWork } from '../resolveUsageHowYouWork.js';

const base = { queryKey: 'evidence', period: { startMs: 0, endMs: 1000 }, asOfMs: 1000, currentness: 'current' as const };
const read = (input: Partial<UsageCoachEvaluationInput>, id: string) =>
    evaluateUsageCoach({ ...base, ...input }).evaluations.find(row => row.detectorId === id);
const loop = { evidenceId: 'l1', observedAtMs: 10, turnId: 't', operationKey: 'op', errorDigest: 'error',
    outcome: 'failed' as const, progress: 'none' as const };
const cache = { evidenceId: 'cache', observedAtMs: 30, inputId: 'i', boundary: 'agent_native_request' as const,
    cacheOutcome: 'miss' as const, missCause: 'ttl_expired' as const, cacheWriteTokens: 100,
    idleMs: 20, ttlMs: 20, prefixDigest: 'b', previousPrefixDigest: 'a' };
const prices = UsageModelPriceCatalogSchema.parse({ v: 1, models: { model: { provider: 'anthropic',
    inputUsdPerMillion: 1, outputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 1.25 } },
    provenance: { source: 'litellm', origin: 'bundled', revision: 'test', asOfMs: 0, fetchStatus: 'ready' } });
const accounting = (reads: number[]) => {
    const contributions = reads.map((cacheRead, index) => {
        const tokens = { input: 0, cacheRead, cacheWrite: 100, output: 0, reasoning: 0, total: cacheRead + 100 };
        return { id: `a${index}`, sessionId: 's', turnId: `t${index}`, modelId: 'model', agentId: 'claude', source: 'native',
            machineId: 'machine', projectKey: null, workspaceId: null, observedAtMs: 10 + index * 10, eventCount: 1,
            tokens, tokenCategories: tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } };
    });
    return UsageAnalyticsQueryResponseSchema.parse({ v: 1, priceCatalog: prices, contributions,
        totals: { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: reads.reduce((sum, value) => sum + value, 0),
            cacheWrite: reads.length * 100, total: reads.reduce((sum, value) => sum + value + 100, 0) },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' }, eventCount: reads.length } });
};

describe('research-grounded Coach rules', () => {
    it('does not price accounting when no observed cache cause or request growth consumes money', () => {
        const value = accounting(Array.from({ length: 128 }, () => 100));
        let lookups = 0;
        value.priceCatalog = { ...prices, models: new Proxy(prices.models, {
            get(target, key, receiver) { lookups++; return Reflect.get(target, key, receiver); },
        }) };
        const result = evaluateUsageCoach({ ...base, period: { startMs: 0, endMs: 10_000 }, asOfMs: 10_000, accounting: value });
        expect(result.evaluations.find(row => row.detectorId === 'context_bloat')?.status).toBe('insufficient_evidence');
        expect(result.findings.find(row => row.detectorId === 'cache_economics')?.classification).toBe('informational');
        expect(lookups).toBe(0);
    });
    it('joins cache requests once and resolves prices by distinct model rather than by request', () => {
        for (const count of [1, 128]) {
            const value = accounting(Array.from({ length: count }, () => 100));
            let modelLookups = 0;
            let sessionReads = 0;
            value.priceCatalog = { ...prices, models: new Proxy(prices.models, {
                get(target, key, receiver) { modelLookups++; return Reflect.get(target, key, receiver); },
            }) };
            value.contributions = value.contributions!.map(row => ({ ...row, get sessionId() { sessionReads++; return 's'; } }));
            const nativeCache = value.contributions.map((row, index) => ({ ...cache, evidenceId: `cache-${index}`,
                observedAtMs: row.observedAtMs, inputId: `input-${index}`, sessionId: 's', turnId: row.turnId!, modelId: 'model',
                ttlMs: 300_000, idleMs: 300_000, rebuildCause: 'unexpected' as const }));
            const result = evaluateUsageCoach({ ...base, period: { startMs: 0, endMs: 10_000 }, asOfMs: 10_000,
                accounting: value, detail: { coverage: 'complete', nativeCache } });
            expect(result.findings.find(row => row.detectorId === 'cache_economics')?.measurements)
                .toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'cache_replacement_premium' })]));
            expect(sessionReads).toBeLessThanOrEqual(12 * count);
            expect(modelLookups).toBe(1);
        }
    });
    it('counts the same answered approvals as Human loop, including earlier requests and immediate decisions', () => {
        const permission = { workId: 'w', requestId: 'within', requestedAtMs: 110, decidedAtMs: 140,
            toolId: 'shell', answeringClientCategory: null };
        const permissions = [permission, permission,
            { ...permission, requestId: 'earlier', requestedAtMs: 90 },
            { ...permission, requestId: 'immediate', requestedAtMs: 150, decidedAtMs: 150 },
            { ...permission, requestId: 'pending', decidedAtMs: null },
            { ...permission, requestId: 'later', decidedAtMs: 210 },
            { ...permission, requestId: 'invalid', requestedAtMs: 160 }];
        const period = { startMs: 100, endMs: 200 };
        const human = resolveUsageHowYouWork({ period, timeZoneOffsetMinutes: 0, detail: { status: 'partial', permissions } });
        const coach = evaluateUsageCoach({ ...base, period, detail: { coverage: 'partial', permissions } });
        const finding = coach.findings.find(row => row.detectorId === 'approval_friction')!;
        expect(human.permissions).toMatchObject({ pairedDecisionCount: 3, decisionLatencyMs: 80 });
        expect(finding.measurements).toEqual(expect.arrayContaining([
            { metric: 'permission_requests', value: human.permissions!.pairedDecisionCount, unit: 'count' },
            { metric: 'permission_wait', value: human.permissions!.decisionLatencyMs, unit: 'milliseconds' },
        ]));
        expect(UsageCoachFindingSchema.safeParse(finding).success).toBe(true);
    });
    it('requires three consecutive identical failures, including the same error and no progress', () => {
        const rows = [loop, { ...loop, evidenceId: 'l2', observedAtMs: 20 }, { ...loop, evidenceId: 'l3', observedAtMs: 30 }];
        expect(read({ detail: { coverage: 'complete', loops: rows.slice(0, 2) } }, 'anomalous_looping_usage')?.status).toBe('no_finding');
        expect(read({ detail: { coverage: 'complete', loops: rows } }, 'anomalous_looping_usage')).toMatchObject({ status: 'finding',
            finding: { basis: { method: 'identical_failures_guidance_v1', kind: 'guidance_derived' } } });
        for (const middle of [{ ...rows[1]!, operationKey: 'other' }, { ...rows[1]!, errorDigest: 'different' },
            { ...rows[1]!, progress: 'observed' as const }]) {
            expect(read({ detail: { coverage: 'complete', loops: [rows[0]!, middle, rows[2]!] } }, 'anomalous_looping_usage')?.status).toBe('no_finding');
        }
    });
    it('uses the actual request TTL and excludes expected rebuilds from cache misses', () => {
        expect(read({ detail: { coverage: 'complete', nativeCache: [{ ...cache, ttlMs: 60 }] } }, 'idle_recaching')?.status).toBe('no_finding');
        expect(read({ detail: { coverage: 'complete', nativeCache: [cache] } }, 'idle_recaching')?.status).toBe('finding');
        expect(read({ detail: { coverage: 'complete', nativeCache: [{ ...cache, ttlMs: null }] } }, 'idle_recaching')?.status).toBe('insufficient_evidence');
        expect(read({ detail: { coverage: 'complete', nativeCache: [{ ...cache, rebuildCause: 'compaction' as const }] } }, 'idle_recaching')?.status).toBe('no_finding');
    });
    it('makes approval waits informational until an exact active TTL is reached', () => {
        const permission = { workId: 'w', requestId: 'p', requestedAtMs: 10, decidedAtMs: 40,
            toolId: 'shell', answeringClientCategory: null, cacheTtlMs: 31 };
        expect(read({ detail: { coverage: 'complete', permissions: [permission] } }, 'approval_friction')).toMatchObject({ status: 'finding',
            finding: { classification: 'informational', severity: 'info' } });
        expect(read({ detail: { coverage: 'complete', permissions: [{ ...permission, cacheTtlMs: 30 }] } }, 'approval_friction'))
            .toMatchObject({ status: 'finding', finding: { classification: 'cost_linked', severity: 'warning' } });
    });
    it('does not call ordinary repeated compactions a storm', () => {
        const c = { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't' };
        expect(read({ detail: { coverage: 'complete', compactions: [c, { ...c, evidenceId: 'c2', observedAtMs: 20 }] } }, 'compaction_storms')?.status)
            .toBe('insufficient_evidence');
    });
    it('flags only three consecutive witnessed immediate refills, resetting on useful space', () => {
        const cycle = { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't', immediateRefillToLimit: true };
        const rows = [cycle, { ...cycle, evidenceId: 'c2', observedAtMs: 20 }, { ...cycle, evidenceId: 'c3', observedAtMs: 30 }];
        expect(read({ detail: { coverage: 'complete', compactions: rows } }, 'compaction_storms')).toMatchObject({ status: 'finding',
            finding: { summaryCode: 'compaction_thrash_observed' } });
        expect(read({ detail: { coverage: 'complete', compactions: [rows[0]!, { ...rows[1]!, immediateRefillToLimit: false }, rows[2]!] } },
            'compaction_storms')?.status).toBe('no_finding');
    });
    it('keeps unused deferred MCP bindings informational, flags witnessed upfront loading', () => {
        const usage = { v: 1 as const, evidenceId: 'mcp', sessionId: 's', turnId: 't', observedAtMs: 50,
            window: { startMs: 10, endMs: 50 }, coverage: 'complete' as const,
            bindings: [{ serverId: 'server', bindingId: 'binding', bindingRevision: 20, serverRevision: 10, catalogRevision: 40,
                toolCallCount: 0, schemaBytes: 100, definitionsLoading: 'deferred' as const }] };
        const deferred = read({ detail: { coverage: 'partial', mcpUsage: [usage] } }, 'mcp_overhead');
        expect(deferred).toMatchObject({ status: 'finding',
            finding: { classification: 'informational' } });
        expect(deferred?.status === 'finding' && deferred.finding.evidenceSeries).toBeUndefined();
        expect(read({ detail: { coverage: 'partial', mcpUsage: [{ ...usage,
            bindings: [{ ...usage.bindings[0]!, definitionsLoading: 'upfront' }] }] } }, 'mcp_overhead')).toMatchObject({ status: 'finding',
            finding: { classification: 'cost_linked' } });
    });
    it('adopts effort audit and fan-out as information without numerical waste thresholds', () => {
        const effort = { evidenceId: 'effort', observedAtMs: 10, effort: 'xhigh', outputTokens: 100, thinkingTokens: 80 };
        const fanout = { evidenceId: 'tree', observedAtMs: 20, parentTokens: 100, subagentTokens: 200 };
        const evaluation = evaluateUsageCoach({ ...base, detail: { coverage: 'partial', effortAudits: [effort], subagentUsage: [fanout] } });
        for (const id of ['effort_audit', 'subagent_fanout']) {
            expect(evaluation.evaluations.find(row => row.detectorId === id)).toMatchObject({ status: 'finding',
                finding: { classification: 'informational', severity: 'info' } });
        }
        expect(evaluation.findings.find(row => row.detectorId === 'effort_audit')).toMatchObject({ evidenceSeries: [
            { metric: 'output_tokens', unit: 'tokens', points: [{ evidenceId: 'effort', observedAtMs: 10, value: 100 }] },
            { metric: 'thinking_tokens', unit: 'tokens', points: [{ evidenceId: 'effort', observedAtMs: 10, value: 80 }] },
        ] });
        expect(evaluation.findings.find(row => row.detectorId === 'subagent_fanout')).toMatchObject({ evidenceSeries: [
            { metric: 'parent_tokens', unit: 'tokens', points: [{ evidenceId: 'tree', observedAtMs: 20, value: 100 }] },
            { metric: 'subagent_tokens', unit: 'tokens', points: [{ evidenceId: 'tree', observedAtMs: 20, value: 200 }] },
        ] });
        expect(read({ detail: { coverage: 'partial' } }, 'effort_audit')?.status).toBe('insufficient_evidence');
    });
    it('excludes rereads across a compaction even when file digests match', () => {
        const file = { evidenceId: 'r1', observedAtMs: 10, turnId: 't', fileKey: 'file', selectionKey: 'all',
            versionDigest: 'v1', reason: 'required' as const };
        expect(read({ detail: { coverage: 'complete', fileReads: [file, { ...file, evidenceId: 'r2', observedAtMs: 30, reason: 'redundant' }],
            compactions: [{ evidenceId: 'c', observedAtMs: 20, sessionId: 's', turnId: 't' }] } }, 'repeated_file_reads')?.status).toBe('no_finding');
    });
    it('does not make full context capacity a Coach trigger', () => {
        const composition = { v: 1 as const, evidenceId: 'full', sessionId: 's', turnId: 't', inputId: 'i', observedAtMs: 10,
            boundary: 'agent_native_request' as const, deliveryKind: 'newTurn' as const, coverage: 'complete_native' as const,
            components: [], contextWindowTokens: 100, nativePrefix: { digest: 'a'.repeat(64), tokenCount: 100, tokenizerId: 'native',
                cacheOutcome: 'unknown' as const, missCause: 'unknown' as const, cacheReadTokens: null, cacheWriteTokens: null, ttlMs: null } };
        expect(read({ composition: [composition] }, 'context_bloat')?.status).toBe('insufficient_evidence');
    });
    it('exposes unavailable conditional candidates rather than manufacturing telemetry', () => {
        const evaluation = evaluateUsageCoach(base);
        expect(evaluation).toMatchObject({ unavailableChecks: [
            { check: 'fast_mode', reason: 'not_available' }, { check: 'scheduled_interval_vs_ttl', reason: 'not_available' },
        ] });
    });
    it('attaches an evidence method and dated primary citation to informational findings too', () => {
        const permission = { workId: 'w', requestId: 'p', requestedAtMs: 10, decidedAtMs: 40,
            toolId: 'shell', answeringClientCategory: null };
        const row = read({ detail: { coverage: 'partial', permissions: [permission] } }, 'approval_friction');
        expect(row).toMatchObject({ status: 'finding', finding: { basis: { method: expect.any(String),
            citations: [expect.objectContaining({ url: expect.stringMatching(/^https:\/\//), sourceKind: 'vendor_docs', asOf: '2026-10-10' })] } } });
    });
    it('owns priced unexpected cache misses once with a cause breakdown, excludes rebuild costs and has no hit target', () => {
        const fact = { ...cache, sessionId: 's', turnId: 't0', modelId: 'model', ttlMs: 300_000, idleMs: 300_000,
            rebuildCause: 'unexpected' as const };
        const input = { accounting: accounting([0]), detail: { coverage: 'complete' as const, nativeCache: [fact] } };
        expect(read(input, 'cache_economics')).toMatchObject({ status: 'finding', finding: {
            classification: 'cost_linked', cacheCauses: [{ cause: 'ttl_expired', cacheWriteTokens: 100, premiumUsd: expect.closeTo(0.000115, 10) }],
        } });
        expect(read({ ...input, detail: { ...input.detail, nativeCache: [{ ...fact, rebuildCause: 'compaction' }] } }, 'cache_economics'))
            .toMatchObject({ status: 'finding', finding: { classification: 'informational', cacheCauses: [] } });
        expect(read({ accounting: accounting([0]) }, 'cache_economics')).toMatchObject({ status: 'finding',
            finding: { classification: 'informational' } });
        const ambiguous = accounting([0]);
        ambiguous.contributions!.push({ ...ambiguous.contributions![0]!, id: 'second-observation-same-request' });
        expect(read({ ...input, accounting: ambiguous }, 'cache_economics')).toMatchObject({ status: 'finding',
            finding: { classification: 'informational', cacheCauses: [{ cause: 'ttl_expired', premiumUsd: null }] } });
    });
    it('reports observed request context growth and catalog cache-read costs, never aggregate buckets as requests', () => {
        const source = accounting([100, 200]);
        expect(read({ accounting: source }, 'context_bloat')).toMatchObject({ status: 'finding', finding: {
            summaryCode: 'context_growth_cost_observed', classification: 'informational', measurements: expect.arrayContaining([
                { metric: 'cached_history_cost', value: expect.closeTo(0.00003, 10), unit: 'currency', currency: 'USD', costKind: 'api_equivalent' },
            ]),
        } });
        const buckets = { ...source, contributions: source.contributions!.map(row => ({ ...row, eventCount: 2 })) };
        expect(read({ accounting: buckets }, 'context_bloat')?.status).toBe('insufficient_evidence');
    });
    it('measures the growing request rather than a later zero-input observation', () => {
        const source = accounting([100, 200, 300, 200, 0]);
        const last = source.contributions!.at(-1)!;
        last.tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, total: 10 };
        last.tokenCategories = last.tokens;
        expect(read({ accounting: source }, 'context_bloat')).toMatchObject({ status: 'finding', finding: {
            measurements: expect.arrayContaining([{ metric: 'composed_tokens', value: 400, unit: 'tokens' }]),
            evidence: expect.arrayContaining([{ kind: 'accounting', id: 'a2', observedAtMs: 30 }]),
            evidenceSeries: [{ metric: 'composed_tokens', unit: 'tokens', points: [
                { evidenceId: 'a0', observedAtMs: 10, value: 200 },
                { evidenceId: 'a1', observedAtMs: 20, value: 300 },
                { evidenceId: 'a2', observedAtMs: 30, value: 400 },
                { evidenceId: 'a3', observedAtMs: 40, value: 300 },
                { evidenceId: 'a4', observedAtMs: 50, value: 0 },
            ] }],
        } });
    });
    it('publishes deduplicated permission-wait observations in time order without filling missing days', () => {
        const permission = { workId: 'w', requestId: 'p', requestedAtMs: 10, decidedAtMs: 40,
            toolId: 'shell', answeringClientCategory: null };
        const later = { ...permission, requestId: 'later', requestedAtMs: 80, decidedAtMs: 150 };
        const row = read({ detail: { coverage: 'partial', permissions: [later, permission, permission,
            { ...permission, requestId: 'unanswered', decidedAtMs: null },
            { ...permission, requestId: 'outside', requestedAtMs: 900, decidedAtMs: 1100 }] } }, 'approval_friction');
        expect(row).toMatchObject({ status: 'finding', finding: { evidence: [
            { kind: 'permission', id: '["w","p"]', observedAtMs: 40 },
            { kind: 'permission', id: '["w","later"]', observedAtMs: 150 },
        ], evidenceSeries: [{ metric: 'permission_wait',
            unit: 'milliseconds', points: [
                { evidenceId: '["w","p"]', observedAtMs: 40, value: 30 },
                { evidenceId: '["w","later"]', observedAtMs: 150, value: 70 },
            ] }] } });
        if (row?.status !== 'finding') throw new Error('Expected measured permission finding');
        const finding = row.finding;
        // Observed from the pre-series evaluator in the RED run: presentation must preserve existing suppression identity.
        expect(finding.evidenceKey).toBe('xhoeq_zc4UUl43aUXSX-Z2cESjPDTGqzSjwt-ERsIUk');
        expect(UsageCoachFindingSchema.safeParse({ ...finding, evidenceSeries: [{ metric: 'permission_wait',
            unit: 'milliseconds', points: [{ evidenceId: 'unwitnessed', observedAtMs: 40, value: 30 }] }] }).success).toBe(false);
        expect(UsageCoachFindingSchema.safeParse({ ...finding, evidenceSeries: [{ metric: 'permission_wait',
            unit: 'milliseconds', points: [{ evidenceId: '["w","p"]', observedAtMs: 41, value: 30 }] }] }).success).toBe(false);
        const samples = finding.evidenceSeries![0]!;
        for (const points of [[], [...samples.points].reverse(), [samples.points[0]!, samples.points[0]!],
            [{ ...samples.points[0]!, value: -1 }], [{ ...samples.points[0]!, extra: true }]]) {
            expect(UsageCoachFindingSchema.safeParse({ ...finding, evidenceSeries: [{ ...samples, points }] }).success).toBe(false);
        }
        const { evidenceSeries: _series, ...withoutSeries } = finding;
        expect(UsageCoachFindingSchema.safeParse(withoutSeries).success).toBe(true);
    });
    it('flags aggregate upfront-definition context share, not an assumed per-tool size', () => {
        const binding = { serverId: 'server', bindingId: 'binding', serverRevision: 10, bindingRevision: 20,
            catalogRevision: 40, toolCallCount: 1, schemaBytes: null, schemaTokens: 6, contextWindowTokens: 100 };
        const usage = { v: 1 as const, evidenceId: 'mcp-share', sessionId: 's', turnId: 't', observedAtMs: 20,
            window: { startMs: 10, endMs: 20 }, coverage: 'complete' as const,
            bindings: [binding, { ...binding, bindingId: 'other', schemaTokens: 4 }] };
        expect(read({ detail: { coverage: 'partial', mcpUsage: [usage] } }, 'mcp_overhead')).toMatchObject({ status: 'finding',
            finding: { classification: 'cost_linked', measurements: expect.arrayContaining([
                { metric: 'loaded_schema_tokens', value: 10, unit: 'tokens' },
            ]) } });
        expect(read({ detail: { coverage: 'partial', mcpUsage: [{ ...usage, bindings: [binding] }] } }, 'mcp_overhead')?.status).toBe('no_finding');
    });
    it('uses U10 user pricing overrides for context and cache economics rather than a competing tariff', () => {
        expect(read({ accounting: accounting([100, 200]), pricingOverrides: { model: { kind: 'rates',
            inputUsdPerMillion: 1, outputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.2, cacheWriteUsdPerMillion: 1.5 } } }, 'context_bloat'))
            .toMatchObject({ status: 'finding', finding: { measurements: expect.arrayContaining([
                { metric: 'cached_history_cost', value: expect.closeTo(0.00006, 10), unit: 'currency', currency: 'USD', costKind: 'api_equivalent' },
            ]) } });
    });
    it('does not inspect accounting when every check is disabled or Account preferences are unavailable', () => {
        for (const preferences of [null, { v: 1 as const, disabledChecks: [...USAGE_COACH_DETECTOR_IDS] }]) {
            const result = evaluateUsageCoach({ ...base, preferences,
                get accounting(): never { throw new Error('Disabled accounting was inspected'); } });
            expect(result.findings).toEqual([]);
            expect(result.evaluations.every(row => row.status === (preferences === null ? 'insufficient_evidence' : 'disabled'))).toBe(true);
        }
    });
    it('excludes native misses following witnessed compaction, without requiring a second rebuild label', () => {
        expect(read({ detail: { coverage: 'complete', nativeCache: [{ ...cache, sessionId: 's', turnId: 't' }],
            compactions: [{ evidenceId: 'c', observedAtMs: 20, sessionId: 's', turnId: 't' }] } }, 'idle_recaching')?.status).toBe('no_finding');
    });
});
