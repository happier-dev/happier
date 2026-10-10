import { describe, expect, it } from 'vitest';
import { applyUsageCoachPreferences, evaluateUsageCoach } from './evaluateUsageCoach.js';
import { USAGE_COACH_DETECTOR_IDS, UsageCoachEvaluationSchema, type UsageCoachEvaluationInput,
    type UsageCoachDetectorId } from './coachFinding.js';
import type { UsagePromptComposition } from './usagePromptComposition.js';
import type { UsageMcpBindingUsage } from './usageMcpBindingUsage.js';
import { getUsageQueryKey, normalizeUsageQuery } from '../../inputs/usageQuery.js';
import { UsageCoachRemedySchema } from './coachRemedy.js';
import { SessionSpawnNewInputV2Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { UsageAnalyticsQueryResponseSchema } from '../usageAnalyticsContracts.js';

const base: UsageCoachEvaluationInput = { queryKey: 'q', period: { startMs: 0, endMs: 1000 }, asOfMs: 1000, currentness: 'current' };
const result = (input: Partial<UsageCoachEvaluationInput>, id: UsageCoachDetectorId) =>
    evaluateUsageCoach({ ...base, ...input }).evaluations.find(row => row.detectorId === id)!;
const component: UsagePromptComposition['components'][number] = { sourceId: '1'.repeat(64), kind: 'instructions',
    digest: 'a'.repeat(64), location: 'system', byteLength: 20, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' };
const composition: UsagePromptComposition = { v: 1, evidenceId: 'prompt', sessionId: 's', turnId: 't', inputId: 'i',
    observedAtMs: 10, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
    components: [component], nativePrefix: null, contextWindowTokens: null };

describe('evidence-bound usage coach', () => {
    it('compares completed identical host requests through exact turn/model/source cost facts, without claiming task quality', () => {
        const requestIdentity = { scopeKey: 'a'.repeat(64), digest: 'b'.repeat(64),
            selection: { agentTargetKey: 'agent:happier.agent.codex:codex', providerConnectionId: null, modelId: 'heavy' } };
        const requests = [{ evidenceId: 'heavy-request', observedAtMs: 100, startedAtMs: 50,
            sessionId: 's', turnId: 'heavy-turn', requestIdentity },
        { evidenceId: 'light-request', observedAtMs: 200, startedAtMs: 150, sessionId: 's', turnId: 'light-turn',
            requestIdentity: { ...requestIdentity, selection: { ...requestIdentity.selection, modelId: 'light' } } }];
        const contribution = (id: string, turnId: string, modelId: string, amount: number, observedAtMs: number) => ({
            id, turnId, modelId, observedAtMs, sessionId: 's', agentId: 'codex', providerConnectionId: null, providerAttribution: 'known',
            machineId: 'machine', projectKey: null, workspaceId: null, source: 'native',
            tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
            cost: { reportedUsd: amount, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const },
        });
        const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
            totals: { tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
                cost: { reportedUsd: 5, estimatedUsd: 0, currency: 'USD' }, eventCount: 2 },
            contributions: [contribution('high', 'heavy-turn', 'heavy', 4, 90), contribution('low', 'light-turn', 'light', 1, 190)],
            coverage: { status: 'complete', reasons: [], sources: [{ source: 'native', path: 'native', status: 'available',
                eventCount: 2, historyComplete: true, asOfMs: 200 }], missingDimensions: [], ranked: [],
                range: { startMs: 0, endMs: 1000, complete: true } },
        });
        const read = (modelRequests = requests, source = accounting) => result({ accounting: source,
            detail: { coverage: 'partial', modelRequests } }, 'model_misfit');
        expect(read()).toMatchObject({ status: 'finding', finding: {
            summaryCode: 'comparable_completed_request_cost_difference', coverage: 'partial',
            evidence: expect.arrayContaining([{ kind: 'accounting', id: 'high', observedAtMs: 90 },
                { kind: 'model_comparison', id: 'light-request', observedAtMs: 200 }]),
            modelComparison: { basis: 'matched_completed_host_request_v1', sessionId: 's', modelId: 'heavy',
                candidateModelId: 'light', providerConnectionId: null, modelCost: 4, candidateCost: 1 },
            measurements: [{ metric: 'observed_cost_difference', value: 3, unit: 'currency', currency: 'USD', costKind: 'reported' }],
        } });
        expect(read([requests[0]!, { ...requests[1]!, requestIdentity: { ...requestIdentity, digest: 'c'.repeat(64) } }]).status).toBe('insufficient_evidence');
        expect(read(requests, { ...accounting, contributions: [accounting.contributions![0]!,
            { ...accounting.contributions![1]!, modelId: 'unknown' }] }).status).toBe('insufficient_evidence');
        expect(read(requests, { ...accounting, contributions: [accounting.contributions![0]!,
            { ...accounting.contributions![1]!, cost: { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' } }] }).status).toBe('insufficient_evidence');
        expect(read(requests, { ...accounting, contributions: [accounting.contributions![0]!,
            { ...accounting.contributions![1]!, providerConnectionId: undefined }] }).status).toBe('insufficient_evidence');
        expect(read(requests, { ...accounting, coverage: { ...accounting.coverage!, status: 'partial' } }).status).toBe('insufficient_evidence');
        expect(read(requests, { ...accounting, contributions: accounting.contributions!.map(row => ({ ...row, providerAttribution: undefined })) }).status).toBe('insufficient_evidence');
        const changedTarget = read(requests.map(row => ({ ...row, requestIdentity: { ...row.requestIdentity,
            selection: { ...row.requestIdentity.selection, modelId: row.turnId === 'light-turn' ? 'other-light' : 'heavy' } } })),
        { ...accounting, contributions: accounting.contributions!.map(row => row.turnId === 'light-turn' ? { ...row, modelId: 'other-light' } : row) });
        const original = read();
        expect(original.status === 'finding' && changedTarget.status === 'finding' && original.finding.evidenceKey !== changedTarget.finding.evidenceKey).toBe(true);
    });
    it('reports zero calls only for a complete witnessed binding window independently of the partial transcript page', () => {
        const usage: UsageMcpBindingUsage = { v: 1, evidenceId: 'mcp-window', sessionId: 's', turnId: 't', observedAtMs: 50,
            window: { startMs: 10, endMs: 50 }, coverage: 'complete' as const,
            bindings: [{ serverId: 'server', bindingId: 'binding', bindingRevision: 20, serverRevision: 10, catalogRevision: 40,
                toolCallCount: 0, schemaBytes: null }] };
        const read = (rows: readonly UsageMcpBindingUsage[]) => result({ detail: { coverage: 'partial', mcpUsage: rows } }, 'mcp_overhead');
        expect(read([usage])).toMatchObject({ status: 'finding', finding: { summaryCode: 'unused_mcp_binding_observed',
            evidence: [{ kind: 'mcp_usage', id: 'mcp-window', observedAtMs: 50 }],
            measurements: [{ metric: 'unused_mcp_bindings', value: 1, unit: 'count' }] } });
        expect(read([{ ...usage, coverage: 'partial' }]).status).toBe('insufficient_evidence');
        expect(read([{ ...usage, bindings: [{ ...usage.bindings[0]!, toolCallCount: 1 }] }]).status).toBe('no_finding');
        expect(read([usage, { ...usage, evidenceId: 'second-window', observedAtMs: 80, window: { startMs: 60, endMs: 80 },
            bindings: [{ ...usage.bindings[0]!, toolCallCount: 1 }] }]).status).toBe('no_finding');
        const old = { ...usage, evidenceId: 'old-catalog-window', bindings: [{ ...usage.bindings[0]!, catalogRevision: 39, toolCallCount: 1 }] };
        expect(read([old, usage])).toMatchObject({ status: 'finding', finding: {
            evidence: [{ kind: 'mcp_usage', id: 'mcp-window', observedAtMs: 50 }] } });
        expect(read([old, { ...usage, coverage: 'partial' }]).status).toBe('insufficient_evidence');
    });
    it('admits a prepared review prompt rather than an arbitrary Session birth envelope', () => {
        const input = { executionTarget: { serverId: 'home', machineId: 'machine' },
            directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            initialInput: { text: 'Review the witnessed duplicate instruction configuration.' } };
        const prepared = UsageCoachRemedySchema.parse({ kind: 'prepared_session', input });
        expect(prepared.kind).toBe('prepared_session');
        if (prepared.kind !== 'prepared_session') throw new Error('Expected prepared review');
        expect(SessionSpawnNewInputV2Schema.safeParse(prepared.input).success).toBe(true);
        expect(UsageCoachRemedySchema.safeParse({ kind: 'prepared_session', input: { ...input,
            initialInput: { text: 'Review', structuredInput: {} } } }).success).toBe(false);
        expect(UsageCoachRemedySchema.safeParse({ kind: 'prepared_session', input: { ...input,
            initialInput: { text: '   ' } } }).success).toBe(false);
        expect(UsageCoachRemedySchema.safeParse({ kind: 'prepared_session', input: { ...input,
            title: 'Unrelated birth configuration' } }).success).toBe(false);
    });
    it('names all eleven capabilities and keeps missing detail insufficient rather than zero', () => {
        const evaluation = UsageCoachEvaluationSchema.parse(evaluateUsageCoach(base));
        expect(evaluation.evaluations.map(row => row.detectorId)).toEqual([...USAGE_COACH_DETECTOR_IDS]);
        expect(evaluation.evaluations.every(row => row.status === 'insufficient_evidence' && row.requiredEvidence.length > 0)).toBe(true);
        expect(evaluation.findings).toEqual([]);
    });
    it('distinguishes changed or necessary reads from witnessed redundant reads of unchanged content', () => {
        const read = { evidenceId: 'r1', observedAtMs: 10, turnId: 't', fileKey: 'opaque-file', selectionKey: 'all',
            versionDigest: 'v1', reason: 'required' as const };
        expect(result({ detail: { coverage: 'complete', fileReads: [read, { ...read, evidenceId: 'r2', observedAtMs: 20,
            versionDigest: 'v2', reason: 'redundant' }] } }, 'repeated_file_reads').status).toBe('no_finding');
        expect(result({ detail: { coverage: 'complete', fileReads: [read, { ...read, evidenceId: 'r2', observedAtMs: 20,
            reason: 'unknown' }] } }, 'repeated_file_reads').status).toBe('insufficient_evidence');
        const found = result({ detail: { coverage: 'complete', fileReads: [read, { ...read, evidenceId: 'r2', observedAtMs: 20,
            reason: 'redundant' }] } }, 'repeated_file_reads');
        expect(found).toMatchObject({ status: 'finding', finding: { summaryCode: 'redundant_unchanged_read_observed',
            measurements: [{ metric: 'unchanged_reads', value: 1, unit: 'count' }] } });
    });
    it('reports observed repeated compactions without fabricating token or dollar savings and deduplicates facts', () => {
        const c = { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't' };
        const found = result({ detail: { coverage: 'partial', compactions: [c, c, { ...c, evidenceId: 'c2', observedAtMs: 20 }] } }, 'compaction_storms');
        expect(found).toMatchObject({ status: 'finding', finding: { coverage: 'partial', summaryCode: 'repeated_compaction_observed',
            measurements: [{ metric: 'compactions', value: 2, unit: 'count' }] } });
        expect(found.status === 'finding' && Object.keys(found.finding)).not.toContain('estimatedSavings');
        expect(result({ detail: { coverage: 'complete', compactions: [c, c] } }, 'compaction_storms').status).toBe('no_finding');
    });
    it('uses paired permission times and does not infer latency from an unanswered request', () => {
        const p = { workId: 'w', requestId: 'p', requestedAtMs: 10, decidedAtMs: 40, toolId: 'shell', answeringClientCategory: null };
        expect(result({ detail: { coverage: 'complete', permissions: [{ ...p, decidedAtMs: null }] } }, 'approval_friction').status)
            .toBe('insufficient_evidence');
        expect(result({ detail: { coverage: 'complete', permissions: [p, p] } }, 'approval_friction')).toMatchObject({ status: 'finding',
            finding: { measurements: [{ metric: 'permission_wait', value: 30, unit: 'milliseconds' },
                { metric: 'permission_requests', value: 1, unit: 'count' }] } });
    });
    it('does not call idle gaps or prefix hash changes causal misses without authoritative native cause', () => {
        const cache = { evidenceId: 'cache', observedAtMs: 30, inputId: 'i', boundary: 'agent_native_request' as const,
            cacheOutcome: 'miss' as const, missCause: 'unknown' as const, cacheWriteTokens: 100,
            idleMs: 20, prefixDigest: 'b', previousPrefixDigest: 'a' };
        expect(result({ detail: { coverage: 'complete', nativeCache: [cache] } }, 'idle_recaching').status).toBe('insufficient_evidence');
        expect(result({ detail: { coverage: 'complete', nativeCache: [cache] } }, 'cache_busting_prompt_changes').status).toBe('insufficient_evidence');
        expect(result({ detail: { coverage: 'complete', nativeCache: [{ ...cache, missCause: 'ttl_expired' }] } }, 'idle_recaching'))
            .toMatchObject({ status: 'finding', finding: { summaryCode: 'idle_cache_recreation_observed' } });
        expect(result({ detail: { coverage: 'complete', nativeCache: [{ ...cache, missCause: 'prefix_change' }] } }, 'cache_busting_prompt_changes'))
            .toMatchObject({ status: 'finding', finding: { summaryCode: 'prefix_change_cache_miss_observed' } });
        expect(result({ detail: { coverage: 'complete', nativeCache: [{ ...cache, missCause: 'ttl_expired', idleMs: null }] } }, 'idle_recaching').status)
            .toBe('insufficient_evidence');
        expect(result({ detail: { coverage: 'complete', nativeCache: [{ ...cache, missCause: 'prefix_change', previousPrefixDigest: null }] } },
            'cache_busting_prompt_changes').status).toBe('insufficient_evidence');
    });
    it('requires matched workload and witnessed outcome before proposing model fit', () => {
        const comparison = { evidenceId: 'm', observedAtMs: 20, workloadKey: 'exact', modelId: 'a', candidateModelId: 'b',
            requiredOutcomeKey: 'checks_passed', modelOutcome: 'met' as const, candidateOutcome: 'unknown' as const,
            costKind: 'reported' as const, currency: 'USD', modelCost: 2, candidateCost: 1 };
        expect(result({ detail: { coverage: 'complete', modelComparisons: [comparison] } }, 'model_misfit').status).toBe('insufficient_evidence');
        expect(result({ detail: { coverage: 'complete', modelComparisons: [{ ...comparison, candidateOutcome: 'met' }] } }, 'model_misfit'))
            .toMatchObject({ status: 'finding', finding: { summaryCode: 'compatible_model_cost_difference',
                measurements: [{ metric: 'observed_cost_difference', currency: 'USD', costKind: 'reported' }] } });
    });
    it('requires repeated failed operations and witnessed absence of progress rather than large token totals', () => {
        const l = { evidenceId: 'l1', observedAtMs: 10, turnId: 't', operationKey: 'op', outcome: 'failed' as const, progress: 'none' as const };
        expect(result({ detail: { coverage: 'complete', loops: [l, { ...l, evidenceId: 'l2', observedAtMs: 20, progress: 'observed' }] } }, 'anomalous_looping_usage').status).toBe('no_finding');
        expect(result({ detail: { coverage: 'complete', loops: [l, { ...l, evidenceId: 'l2', observedAtMs: 20 }] } }, 'anomalous_looping_usage'))
            .toMatchObject({ status: 'finding', finding: { summaryCode: 'failed_loop_observed' } });
    });
    it('names actual outside-Happier native accounting without calling it unwanted or cron', () => {
        const tokens = { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 100 };
        const accounting = { v: 1 as const, totals: { eventCount: 1, tokens,
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            coverage: { status: 'complete' as const, reasons: [], missingDimensions: [],
                sources: [{ source: 'collector', path: 'native' as const, status: 'available' as const, asOfMs: 1000, eventCount: 1 }],
                range: { startMs: 0, endMs: 1000, complete: true }, ranked: [] },
            contributions: [{ id: 'a', observedAtMs: 20, sessionId: null, turnId: null, agentId: 'agent', modelId: 'model',
                machineId: 'm', projectKey: null, workspaceId: null, source: 'collector', tokens,
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }] };
        expect(result({ accounting }, 'outside_usage')).toMatchObject({ status: 'finding', finding: {
            summaryCode: 'outside_happier_usage_observed', measurements: [{ metric: 'outside_tokens', value: 100, unit: 'tokens' }] } });
        expect(result({ accounting: { ...accounting, coverage: undefined } }, 'outside_usage').status).toBe('insufficient_evidence');
        expect(result({ accounting: { ...accounting, contributions: [{ ...accounting.contributions[0]!, sessionId: 'linked' }] } }, 'outside_usage').status).toBe('no_finding');
    });
    it('never proves a negative from partial detail or includes facts outside the requested period', () => {
        expect(result({ detail: { coverage: 'partial', compactions: [] } }, 'compaction_storms').status).toBe('insufficient_evidence');
        const c = { evidenceId: 'c1', observedAtMs: 1001, sessionId: 's', turnId: null };
        expect(result({ detail: { coverage: 'complete', compactions: [c, { ...c, evidenceId: 'c2' }] } }, 'compaction_storms').status).toBe('no_finding');
    });
    it('requires actual duplicate injections, not just two instruction files or overlapping portions', () => {
        expect(result({ composition: [{ ...composition, components: [component, { ...component, digest: 'b'.repeat(64) }] }] },
            'duplicated_instructions').status).toBe('insufficient_evidence');
        expect(result({ composition: [{ ...composition, components: [component, { ...component, sourceId: '2'.repeat(64), overlap: 'known' }] }] },
            'duplicated_instructions').status).toBe('insufficient_evidence');
        expect(result({ composition: [{ ...composition, components: [component, { ...component, sourceId: '2'.repeat(64) }] }] },
            'duplicated_instructions')).toMatchObject({ status: 'finding', finding: { summaryCode: 'duplicate_injection_observed',
                measurements: [{ metric: 'duplicate_injections', value: 1, unit: 'count' }, { metric: 'duplicate_bytes', value: 20, unit: 'bytes' }] } });
    });
    it('requires witnessed MCP binding inventory and calls, not schema sizes or an unloaded invocation log', () => {
        expect(result({ composition: [composition], detail: { coverage: 'complete', toolUses: [] } }, 'mcp_overhead').status).toBe('insufficient_evidence');
        const schema = { ...composition, components: [{ ...component, kind: 'mcp_schema' as const }] };
        expect(result({ composition: [schema], detail: { coverage: 'partial', toolUses: [] } }, 'mcp_overhead').status).toBe('insufficient_evidence');
        expect(result({ composition: [schema], detail: { coverage: 'complete', toolUses: [] } }, 'mcp_overhead'))
            .toMatchObject({ status: 'insufficient_evidence' });
        expect(result({ composition: [schema], detail: { coverage: 'complete', toolUses: [{ evidenceId: 'u', observedAtMs: 20,
            serverKey: component.sourceId, toolId: 'tool' }] } }, 'mcp_overhead').status).toBe('insufficient_evidence');
    });
    it('requires a witnessed native context denominator and prefix size rather than processed tokens or host-only sizes', () => {
        expect(result({ composition: [{ ...composition, contextWindowTokens: 10 }] }, 'context_bloat').status).toBe('insufficient_evidence');
        const native: UsagePromptComposition = { ...composition, boundary: 'agent_native_request', coverage: 'complete_native',
            contextWindowTokens: 100, nativePrefix: { digest: 'b'.repeat(64), tokenCount: 100, tokenizerId: 'native',
                cacheOutcome: 'unknown', missCause: 'unknown', cacheReadTokens: null, cacheWriteTokens: null, ttlMs: null } };
        expect(result({ composition: [native] }, 'context_bloat')).toMatchObject({ status: 'finding', finding: {
            measurements: [{ metric: 'composed_tokens', value: 100, unit: 'tokens' }, { metric: 'context_window_tokens', value: 100, unit: 'tokens' }] } });
        expect(result({ compositionCoverage: 'complete', composition: [{ ...native, nativePrefix: { ...native.nativePrefix!, tokenCount: 10 } }] }, 'context_bloat').status).toBe('no_finding');
    });
    it('consumes a native context cache cause while leaving host-only prefix changes insufficient', () => {
        const previous: UsagePromptComposition = { ...composition, evidenceId: 'p1', boundary: 'agent_native_request', coverage: 'complete_native',
            nativePrefix: { digest: 'a'.repeat(64), tokenCount: 100, tokenizerId: 'native', cacheOutcome: 'hit', missCause: 'unknown',
                cacheReadTokens: 100, cacheWriteTokens: 0, ttlMs: null } };
        const changed: UsagePromptComposition = { ...previous, evidenceId: 'p2', inputId: 'i2', observedAtMs: 20,
            nativePrefix: { ...previous.nativePrefix!, digest: 'b'.repeat(64), cacheOutcome: 'miss', missCause: 'prefix_change', cacheWriteTokens: 100 } };
        expect(result({ composition: [previous, changed] }, 'cache_busting_prompt_changes'))
            .toMatchObject({ status: 'finding', finding: { summaryCode: 'prefix_change_cache_miss_observed' } });
        expect(result({ composition: [previous, { ...changed, nativePrefix: { ...changed.nativePrefix!, missCause: 'unknown' } }] },
            'cache_busting_prompt_changes').status).toBe('insufficient_evidence');
        expect(result({ composition: [composition, { ...composition, evidenceId: 'host2', observedAtMs: 20,
            components: [{ ...component, digest: 'b'.repeat(64) }] }] }, 'cache_busting_prompt_changes').status).toBe('insufficient_evidence');
    });
    it('preserves stale currentness and binds evidence identity to actual observations', () => {
        const c = { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't' };
        const input = { detail: { coverage: 'complete' as const, compactions: [c, { ...c, evidenceId: 'c2', observedAtMs: 20 }] } };
        const first = result(input, 'compaction_storms');
        const second = result({ ...input, currentness: 'stale' }, 'compaction_storms');
        expect(first.status).toBe('finding');
        expect(second).toMatchObject({ status: 'finding', finding: { currentness: 'stale' } });
        if (first.status === 'finding' && second.status === 'finding') expect(first.finding.evidenceKey).toBe(second.finding.evidenceKey);
        expect(UsageCoachEvaluationSchema.safeParse({ ...evaluateUsageCoach(base), arbitrary: {} }).success).toBe(false);
    });
    it('keeps open-query evidence identity stable across witnessed rereads, but not changed facts', () => {
        const query = normalizeUsageQuery({ period: { startMs: 0 }, session: 's' });
        const queryKey = getUsageQueryKey(query);
        const permission = { workId: 'w', requestId: 'approval', requestedAtMs: 10, decidedAtMs: 40,
            toolId: 'shell', answeringClientCategory: null };
        const prompt = { ...composition, components: [component, { ...component, sourceId: '2'.repeat(64) }] };
        const evidence = { composition: [prompt], detail: { coverage: 'partial' as const, permissions: [permission] } };
        const first = evaluateUsageCoach({ ...base, ...evidence, queryKey, asOfMs: 100, period: { startMs: 0, endMs: 100 } });
        const second = evaluateUsageCoach({ ...base, ...evidence, queryKey: getUsageQueryKey(normalizeUsageQuery(query)),
            asOfMs: 200, period: { startMs: 0, endMs: 200 } });
        const changed = evaluateUsageCoach({ ...base, queryKey, asOfMs: 200, period: { startMs: 0, endMs: 200 },
            composition: [{ ...prompt, evidenceId: 'next-prompt', observedAtMs: 20 }],
            detail: { coverage: 'partial', permissions: [{ ...permission, decidedAtMs: 50 }] } });
        for (const detectorId of ['duplicated_instructions', 'approval_friction'] as const) {
            const key = (evaluation: typeof first) => evaluation.findings.find(row => row.detectorId === detectorId)!.evidenceKey;
            expect(key(second)).toBe(key(first));
            expect(key(changed)).not.toBe(key(first));
        }
    });
    it('refuses a serialized public result that swaps evidence, remedy identity or evaluated concepts', () => {
        // These are transport tamper cases: a typed finding must not advertise another finding's Apply.
        const c = { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't' };
        const value = evaluateUsageCoach({ ...base, detail: { coverage: 'complete', compactions: [c, { ...c, evidenceId: 'c2', observedAtMs: 20 }] } });
        const transport: typeof value = JSON.parse(JSON.stringify(value));
        expect(UsageCoachEvaluationSchema.safeParse({ ...evaluateUsageCoach(base), asOfMs: null, currentness: 'unknown' }).success).toBe(true);
        expect(UsageCoachEvaluationSchema.safeParse({ ...evaluateUsageCoach(base), asOfMs: null, currentness: 'current' }).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse({ ...transport, evaluations: transport.evaluations.slice(1) }).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse({ ...transport, evaluations: [transport.evaluations[0], ...transport.evaluations.slice(0, -1)] }).success).toBe(false);
        const index = transport.evaluations.findIndex(row => row.status === 'finding');
        expect(index).toBeGreaterThanOrEqual(0);
        const finding = transport.findings[0]!;
        expect(UsageCoachEvaluationSchema.safeParse({ ...transport, findings: [{ ...finding, detectorId: 'approval_friction' }] }).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse({ ...transport, evaluations: transport.evaluations.map((row, i) =>
            i === index ? { ...row, detectorId: 'approval_friction' } : row) }).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse({ ...transport, findings: [{ ...finding, evidenceKey: 'different' }] }).success).toBe(false);
        const remedy = { kind: 'model' as const, sessionId: 's', modelId: 'm' };
        const replaceFinding = (next: typeof finding) => ({ ...transport, findings: [next],
            evaluations: transport.evaluations.map(row => row.status === 'finding' ? { ...row, finding: next } : row) });
        expect(UsageCoachEvaluationSchema.safeParse(replaceFinding({ ...finding, remedy,
            action: { actionId: 'usage.coach.apply', detectorId: finding.detectorId, evidenceKey: 'wrong' } })).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse(replaceFinding({ ...finding, remedy })).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse(replaceFinding({ ...finding, queryKey: 'other-query' })).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse(replaceFinding({ ...finding, period: { startMs: 0, endMs: 999 } })).success).toBe(false);
        expect(UsageCoachEvaluationSchema.safeParse(replaceFinding({ ...finding, evidenceKey: 'plugin-owned-opaque-key' })).success).toBe(true);
    });
    it('applies Account preferences only to exact finding evidence and expires snooze at the explicit clock', () => {
        const c = { evidenceId: 'c1', observedAtMs: 10, sessionId: 's', turnId: 't' };
        const evaluation = evaluateUsageCoach({ ...base, detail: { coverage: 'complete', compactions: [c, { ...c, evidenceId: 'c2', observedAtMs: 20 }] } });
        const key = evaluation.findings[0]!.evidenceKey;
        const preferences = { v: 1 as const,
            suppressions: [{ kind: 'dismissed' as const, evidenceKey: key }] };
        expect(applyUsageCoachPreferences(evaluation, preferences, 30).findings[0]!.state.dismissed).toBe(true);
        expect(applyUsageCoachPreferences(evaluation, { ...preferences, suppressions: [{ kind: 'dismissed', evidenceKey: 'different' }] }, 30)
            .findings[0]!.state.dismissed).toBe(false);
        const snoozed = { ...preferences, suppressions: [{ kind: 'snoozed' as const, evidenceKey: key, untilMs: 40 }] };
        expect(applyUsageCoachPreferences(evaluation, snoozed, 30).findings[0]!.state.snoozedUntilMs).toBe(40);
        expect(applyUsageCoachPreferences(evaluation, snoozed, 40).findings[0]!.state.snoozedUntilMs).toBeNull();
        const changed = evaluateUsageCoach({ ...base, detail: { coverage: 'complete', compactions: [c, { ...c, evidenceId: 'c3', observedAtMs: 20 }] } });
        expect(applyUsageCoachPreferences(changed, preferences, 30).findings[0]!.state.dismissed).toBe(false);
    });
});
