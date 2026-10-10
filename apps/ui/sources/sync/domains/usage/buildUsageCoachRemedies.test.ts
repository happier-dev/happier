import { describe, expect, it } from 'vitest';
import { UsageCoachFindingSchema } from '@happier-dev/protocol/usage/coach/coachFinding';
import { UsagePromptCompositionSchema } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildUsageCoachRemedies } from './buildUsageCoachRemedies';
import { evaluateUsageCoach } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { UsageMcpBindingUsageSchema } from '@happier-dev/protocol/usage/coach/usageMcpBindingUsage';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/catalogSchemasV1';

const composition = UsagePromptCompositionSchema.parse({ v: 1, evidenceId: 'composition', sessionId: 'session', turnId: 'turn',
    inputId: 'input', observedAtMs: 150, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
    components: [0, 1].map(() => ({ sourceId: 'a'.repeat(64), digest: 'b'.repeat(64), kind: 'instructions', location: 'user',
        byteLength: 200, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' })),
    nativePrefix: null, contextWindowTokens: null });
// The builder consumes the evaluator's strict finding contract; detector behavior has its own source tests.
const findings = [UsageCoachFindingSchema.parse({ detectorId: 'duplicated_instructions', evidenceKey: 'finding',
    queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200, currentness: 'current', coverage: 'partial',
    severity: 'info', summaryCode: 'duplicate_injection_observed', evidence: [{ kind: 'composition', id: 'composition', observedAtMs: 150 }],
    measurements: [{ metric: 'duplicate_injections', value: 1, unit: 'count' }], remedy: null, action: null,
    state: { dismissed: false, snoozedUntilMs: null, applied: null } })];
const session = createSessionFixture({ id: 'session', serverId: 'home', metadata: { path: '/workspace/project', host: 'host',
    machineId: 'machine', agent: 'codex', agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } });

describe('Coach repository remedy preparation', () => {
    it('proposes disabling only the current witnessed enabled binding with the actual catalog row revision', () => {
        const usage = UsageMcpBindingUsageSchema.parse({ v: 1, evidenceId: 'mcp-window', sessionId: 'session', turnId: 'turn',
            observedAtMs: 150, window: { startMs: 100, endMs: 150 }, coverage: 'complete', bindings: [{ serverId: 'server',
                bindingId: 'binding', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
        const current: McpServerCatalogSnapshotV1 = { status: 'ready', authority: 'active', revision: 40, diagnostics: [],
            catalog: { v: 1, servers: [{ id: 'server', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] },
                env: {}, createdAt: 1, updatedAt: 10 }], bindings: [{ id: 'binding', serverId: 'server', enabled: true,
                    target: { t: 'allMachines' }, createdAt: 1, updatedAt: 20 }] } };
        const evaluation = evaluateUsageCoach({ queryKey: 'q', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
            currentness: 'current', detail: { coverage: 'partial', mcpUsage: [usage] } });
        const read = (mcpCatalog: McpServerCatalogSnapshotV1) => buildUsageCoachRemedies({ findings: evaluation.findings,
            composition: [], mcpUsage: [usage], mcpCatalog, sessions: [session], serverId: 'home' });
        expect(read(current)).toEqual([{ detectorId: 'mcp_overhead', evidenceIds: ['mcp-window'],
            remedy: { kind: 'mcp_binding', bindingId: 'binding', enabled: false, expectedRevision: 40 } }]);
        expect(read({ ...current, authority: 'inactive' })).toEqual([]);
        expect(read({ ...current, status: 'partial' })).toEqual([]);
        expect(read({ ...current, catalog: { ...current.catalog, bindings: [{ ...current.catalog.bindings[0]!, updatedAt: 21 }] } })).toEqual([]);
        expect(read({ ...current, revision: 41 })).toEqual([]);
        const stale = { ...usage, evidenceId: 'old-window', observedAtMs: 140, window: { startMs: 100, endMs: 140 },
            bindings: [{ ...usage.bindings[0]!, catalogRevision: 39, toolCallCount: 1 }] };
        const readWindows = (mcpUsage: typeof usage[]) => buildUsageCoachRemedies({
            findings: evaluateUsageCoach({ queryKey: 'q', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
                currentness: 'current', detail: { coverage: 'partial', mcpUsage } }).findings,
            composition: [], mcpUsage, mcpCatalog: current, sessions: [session], serverId: 'home' });
        expect(readWindows([stale, usage])).toEqual(read(current));
        const later = { ...usage, evidenceId: 'later-window', observedAtMs: 180, window: { startMs: 160, endMs: 180 } };
        expect(readWindows([usage, { ...later, bindings: [{ ...usage.bindings[0]!, toolCallCount: 1 }] }])).toEqual([]);
        expect(readWindows([usage, { ...later, coverage: 'partial' }])).toEqual([]);
    });
    it('proposes the observed cheaper completed-request model only against exact current inactive intent', () => {
        const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'heavy' };
        const finding = UsageCoachFindingSchema.parse({ ...findings[0], detectorId: 'model_misfit',
            summaryCode: 'comparable_completed_request_cost_difference', evidence: [
                { kind: 'model_comparison', id: 'heavy-request', observedAtMs: 150 },
                { kind: 'model_comparison', id: 'light-request', observedAtMs: 160 },
            ], modelComparison: { basis: 'matched_completed_host_request_v1', sessionId: 'session',
                agentTargetKey: selection.agentTargetKey, providerConnectionId: null, modelId: 'heavy', candidateModelId: 'light',
                modelTurnId: 'heavy-turn', candidateTurnId: 'light-turn', requestKey: 'b'.repeat(64), requestScopeKey: 'a'.repeat(64),
                modelCost: 4, candidateCost: 1, currency: 'USD', costKind: 'reported' } });
        const target = { ...session, active: false, metadata: { ...session.metadata!,
            modelSelectionIntentV1: { v: 1 as const, selection, updatedAt: 140 } } };
        const read = (value = target) => buildUsageCoachRemedies({ findings: [finding], composition: [],
            sessions: [value], serverId: 'home', accountId: 'account' });
        expect(read()).toMatchObject([{ detectorId: 'model_misfit', evidenceIds: ['heavy-request', 'light-request'],
            remedy: { kind: 'model', sessionId: 'session', modelId: 'light', providerConnectionId: null,
                expected: { owner: 'inactive', scope: { serverId: 'home', accountId: 'account', sessionId: 'session' },
                    selection, updatedAt: 140 } } }]);
        expect(read({ ...target, active: true })).toEqual([]);
        expect(read({ ...target, metadata: { ...target.metadata, modelSelectionIntentV1: {
            ...target.metadata.modelSelectionIntentV1, selection: { ...selection, modelId: 'intervening' } } } })).toEqual([]);
        expect(read({ ...target, access: createSessionAccessFixture('view') })).toEqual([]);
    });
    it('prepares a review-prompt Session on the exactly witnessed source and delegates all repository work', () => {
        const proposals = buildUsageCoachRemedies({ findings, composition: [composition], sessions: [session], serverId: 'home' });
        expect(proposals).toMatchObject([{ detectorId: 'duplicated_instructions', evidenceIds: ['composition'],
            remedy: { kind: 'prepared_session', input: { executionTarget: { serverId: 'home', machineId: 'machine' },
                directory: { kind: 'path', path: '/workspace/project' }, initialInput: { text: expect.any(String) } } } }]);
        expect(proposals[0]?.remedy.kind).toBe('prepared_session');
    });
    it('withholds a prepared remedy when its source is ambiguous, foreign or has no input authority', () => {
        const read = (sessions: readonly typeof session[], records = [composition]) => buildUsageCoachRemedies({
            findings, composition: records, sessions, serverId: 'home' });
        expect(read([{ ...session, serverId: 'other-home' }])).toEqual([]);
        expect(read([{ ...session, access: createSessionAccessFixture('view') }])).toEqual([]);
        expect(read([session], [{ ...composition, sessionId: 'unknown' }])).toEqual([]);
        expect(read([session, { ...session }])).toEqual([]);
    });
});
