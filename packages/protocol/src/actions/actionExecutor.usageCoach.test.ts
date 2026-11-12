import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec, SignedRootActionIdSchema } from './actionSpecs.js';
import { resolveCredentialActionAdmissionV1 } from './decisionAuthority.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import type { ActionId } from './actionIds.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { UsageCoachPreferencesV1Schema } from '../account/settings/usageCoachPreferencesV1.js';
import { buildUsageCoachRemedies } from '../usage/coach/buildUsageCoachRemedies.js';
import { applyUsageCoachPreferences, evaluateUsageCoach } from '../usage/coach/evaluateUsageCoach.js';
import { UsageMcpBindingUsageSchema } from '../usage/coach/usageMcpBindingUsage.js';
import { UsageCoachApplyResultSchema, createUsageCoachSuppressionPort, UsageCoachSuppressionStateV1Schema } from '../usage/coach/coachActions.js';
import { createMcpServerActionExecuteV1 } from '../mcp/servers/serverActionsV1.js';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '../mcp/servers/serverCatalogV1.js';
import type { McpServerCatalogV1 } from '../mcp/servers/serverRowsV1.js';

const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });

// Substitute only persistence; Action admission, edit and projection stay real.
function coachKv(read: () => ReturnType<typeof UsageCoachSuppressionStateV1Schema.parse>,
    write: (value: ReturnType<typeof UsageCoachSuppressionStateV1Schema.parse>) => void) {
    let version = 0;
    return createUsageCoachSuppressionPort({ transport: {
        read: async () => ({ value: { v: 1, suppressions: read().suppressions }, version }),
        compareAndSet: async (value, expected) => {
            if (version !== expected) return { success: false, value: { v: 1, suppressions: read().suppressions }, version };
            write({ ...read(), ...UsageCoachSuppressionStateV1Schema.parse(value) });
            return { success: true, version: ++version };
        },
    } });
}

describe('evidence-bound Coach Action admission', () => {
    it('lets Account automation dismiss, restore and snooze its own finding without approval', async () => {
        // Home uses this admission for terminal credentials with no delegated grant.
        for (const id of ['usage.coach.dismiss', 'usage.coach.snooze'] as const) {
            expect(SignedRootActionIdSchema.safeParse(id).success).toBe(true);
            expect(resolveCredentialActionAdmissionV1({ spec: getActionSpec(id),
                authority: 'account_automation', grant: null, surface: 'cli' })).toMatchObject({ ok: true });
        }
        const aggregate = () => resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, asOfMs: 200,
            detail: { status: 'partial', permissions: [{ requestId: 'p', workId: 'w', requestedAtMs: 120,
                decidedAtMs: 160, toolId: null, answeringClientCategory: null }] } }] });
        const base = aggregate().results[0]!.coach!;
        const evidenceKey = base.findings[0]!.evidenceKey;
        let state = UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions: [] });
        const executor = createActionExecutor({ usageActions: {
            query: async () => {
                const batch = aggregate();
                return { ...batch, results: batch.results.map(slice => ({ ...slice,
                    coach: applyUsageCoachPreferences(slice.coach!, state, 200) })) };
            },
            coachSuppressions: () => coachKv(() => state, value => { state = value; }),
        } } as ActionExecutorDeps);
        const context = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
        const read = () => executor.execute('usage.query', { queries: [query] }, context);
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: true }, context)).toMatchObject({ ok: true });
        expect(await read()).toMatchObject({ ok: true, result: { results: [{ coach: { findings: [{ state: { dismissed: true } }] } }] } });
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: false }, context)).toMatchObject({ ok: true });
        expect(await read()).toMatchObject({ ok: true, result: { results: [{ coach: { findings: [{ state: { dismissed: false } }] } }] } });
        expect(await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs: 300 }, context)).toMatchObject({ ok: true });
        expect(await read()).toMatchObject({ ok: true, result: { results: [{ coach: { findings: [{ state: { snoozedUntilMs: 300 } }] } }] } });
        expect(await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs: null }, context)).toMatchObject({ ok: true });
        expect(await read()).toMatchObject({ ok: true, result: { results: [{ coach: { findings: [{ state: { snoozedUntilMs: null } }] } }] } });
    });

    it('replaces deliberate Coach preferences without requiring suppression storage', async () => {
        let preferences: unknown = UsageCoachPreferencesV1Schema.parse({});
        const executor = createActionExecutor({
            settingsDeclarationAction: async request => {
                preferences = 'value' in request.input ? request.input.value : undefined;
                return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: 2 };
            },
        } as ActionExecutorDeps);
        const edited = { v: 1, disabledChecks: ['approval_friction'], modelSuggestion: 'off' };
        expect(await executor.execute('settings.set', { anchor: 'usage.coachPreferences', value: edited },
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
        expect(preferences).toEqual(edited);
    });
    it('dismisses and restores without writing Account settings', async () => {
        let preferences = UsageCoachPreferencesV1Schema.parse({});
        let kv = UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions: [] });
        const owner = coachKv(() => kv, value => { kv = value; });
        const settingsWrites: unknown[] = [];
        const executor = createActionExecutor({
            usageActions: { query: async () => resolveUsagePageAggregation({ queries: [query] }), coachSuppressions: () => owner },
            settingsDeclarationAction: async request => {
                if (request.actionId === 'settings.set') {
                    settingsWrites.push(request.input);
                    preferences = UsageCoachPreferencesV1Schema.parse('value' in request.input ? request.input.value : undefined);
                }
                return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: 1 };
            },
        } as ActionExecutorDeps);
        const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey: 'historical', dismissed: true }, context)).toMatchObject({ ok: true });
        expect(settingsWrites).toEqual([]);
        expect((await owner.read()).suppressions).toEqual([{ kind: 'dismissed', evidenceKey: 'historical' }]);
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey: 'historical', dismissed: false }, context)).toMatchObject({ ok: true });
        expect(settingsWrites).toEqual([]);
        expect((await owner.read()).suppressions).toEqual([]);
    });
    it('deduplicates exact evidence without suppressing another finding from the same check', async () => {
        let preferences = UsageCoachPreferencesV1Schema.parse({});
        let suppressions = UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions: [] });
        let settingsVersion = 1;
        const read = (selected: typeof query, coachPreferences = preferences) => {
            const startMs = 'startMs' in selected.period ? selected.period.startMs! : 100;
            return resolveUsagePageAggregation({ queries: [selected], coachPreferences, howYouWork: [{ query: selected, asOfMs: startMs + 100,
                detail: { status: 'partial', permissions: [{ requestId: `permission-${startMs}`, workId: 'work',
                    requestedAtMs: startMs + 20, decidedAtMs: startMs + 60, toolId: null, answeringClientCategory: null }] } }] });
        };
        let batch = read(query);
        let analyticsReads = 0;
        const executor = createActionExecutor({
            usageActions: { query: async () => { analyticsReads += 1; return batch; },
                coachSuppressions: () => coachKv(() => suppressions, value => { suppressions = value; }) },
            settingsDeclarationAction: async request => {
                if (request.actionId === 'settings.get') return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion };
                preferences = UsageCoachPreferencesV1Schema.parse('value' in request.input ? request.input.value : undefined);
                return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: ++settingsVersion };
            },
        } as ActionExecutorDeps);
        const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const originalKey = batch.results[0]!.coach!.findings[0]!.evidenceKey;
        for (let repeat = 0; repeat < 2; repeat++) {
            batch = read(query);
            expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey: originalKey, dismissed: true }, context))
                .toMatchObject({ ok: true });
        }
        expect(suppressions.suppressions).toHaveLength(1);
        const original = applyUsageCoachPreferences(read(query).results[0]!.coach!, suppressions, Date.now());
        expect(original.findings[0]!.state.dismissed).toBe(true);
        const nextQuery = normalizeUsageQuery({ period: { startMs: 200, endMs: 300 } });
        batch = read(nextQuery);
        const next = applyUsageCoachPreferences(batch.results[0]!.coach!, suppressions, Date.now());
        expect(next.findings[0]!.detectorId).toBe(original.findings[0]!.detectorId);
        expect(next.findings[0]!.evidenceKey).not.toBe(originalKey);
        expect(next.findings[0]!.state.dismissed).toBe(false);
        expect(await executor.execute('usage.coach.dismiss', { query: nextQuery,
            evidenceKey: next.findings[0]!.evidenceKey, dismissed: true }, context)).toMatchObject({ ok: true });
        expect(suppressions.suppressions).toHaveLength(2);
        // Reopening an old absolute window reproduces its exact evidence key and preference.
        const reopened = applyUsageCoachPreferences(read(query).results[0]!.coach!, suppressions, Date.now());
        expect(reopened.findings[0]!.evidenceKey).toBe(originalKey);
        expect(reopened.findings[0]!.state.dismissed).toBe(true);
        const disabled = read(nextQuery, { ...preferences, disabledChecks: ['approval_friction'] }).results[0]!.coach!;
        expect(disabled.evaluations.find(row => row.detectorId === 'approval_friction')?.status).toBe('disabled');
        expect(disabled.findings).toEqual([]);
        expect(analyticsReads).toBe(0);
        expect(await executor.execute('usage.coach.apply', { query: nextQuery, evidenceKey: originalKey }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_evidence_not_current' });
        analyticsReads = 0;
        const untilMs = Date.now() + 60_000;
        for (let repeat = 0; repeat < 2; repeat++) {
            batch = read(query);
            expect(await executor.execute('usage.coach.snooze', { query, evidenceKey: originalKey, untilMs }, context)).toMatchObject({ ok: true });
        }
        expect(suppressions.suppressions).toHaveLength(2);
        expect(applyUsageCoachPreferences(read(query).results[0]!.coach!, suppressions, Date.now()).findings[0]!.state.snoozedUntilMs).toBe(untilMs);
        expect(applyUsageCoachPreferences(read(nextQuery).results[0]!.coach!, suppressions, Date.now()).findings[0]!.state.snoozedUntilMs).toBeNull();
        // Restoring the historical key does not require it to be in the latest analytics.
        batch = read(nextQuery);
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey: originalKey,
            dismissed: false }, context)).toMatchObject({ ok: true });
        expect(suppressions.suppressions).toEqual([{ kind: 'dismissed', evidenceKey: next.findings[0]!.evidenceKey }]);
        batch = read(nextQuery);
        expect(await executor.execute('usage.coach.dismiss', { query: nextQuery, evidenceKey: next.findings[0]!.evidenceKey,
            dismissed: false }, context)).toMatchObject({ ok: true });
        expect(suppressions.suppressions).toEqual([]);
        expect(analyticsReads).toBe(0);
    });
    it('retains historical snoozes while projecting expired snoozes as inactive', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(250);
        try {
            const detail = { status: 'partial' as const, permissions: [{ requestId: 'permission', workId: 'work',
                requestedAtMs: 120, decidedAtMs: 160, toolId: null, answeringClientCategory: null }] };
            const batch = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, detail, asOfMs: 200 }] });
            const evaluation = batch.results[0]!.coach!;
            const finding = evaluation.findings[0]!;
            const retained = [{ kind: 'dismissed' as const, evidenceKey: 'historical-unrelated' },
                { kind: 'snoozed' as const, evidenceKey: 'expired-unrelated', untilMs: 250 },
                { kind: 'snoozed' as const, evidenceKey: 'live-unrelated', untilMs: 251 }];
            let suppressions = UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions: [
                { kind: 'dismissed', evidenceKey: finding.evidenceKey }, ...retained] });
            expect(applyUsageCoachPreferences(evaluation, suppressions, 250).findings[0]!.state.dismissed).toBe(true);
            const executor = createActionExecutor({ usageActions: { query: async () => batch,
                coachSuppressions: () => coachKv(() => suppressions, value => { suppressions = value; }) },
            } as ActionExecutorDeps);
            const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
            expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey: finding.evidenceKey, dismissed: true }, context))
                .toMatchObject({ ok: true });
            expect(suppressions.suppressions).toHaveLength(4);
            expect(suppressions.suppressions).toEqual(expect.arrayContaining(retained));
            expect(suppressions.suppressions.some(row => row.evidenceKey === finding.evidenceKey)).toBe(true);
            expect(applyUsageCoachPreferences(evaluation, suppressions, 250).findings[0]!.state.dismissed).toBe(true);
            expect(await executor.execute('usage.coach.snooze', { query, evidenceKey: finding.evidenceKey, untilMs: 250 }, context))
                .toMatchObject({ ok: true });
            expect(suppressions.suppressions).toEqual([...retained,
                { kind: 'snoozed', evidenceKey: finding.evidenceKey, untilMs: 250 }]);
            expect(applyUsageCoachPreferences(evaluation, suppressions, 250).findings[0]!.state)
                .toMatchObject({ dismissed: false, snoozedUntilMs: null });
        } finally { clock.mockRestore(); }
    });
    it('composes witnessed MCP remedies with exact Undo and refuses intervening catalog edits', async () => {
        let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'server', name: 'docs', transport: 'stdio',
            stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 10 },
            { id: 'other-server', name: 'other', transport: 'stdio', stdio: { command: 'other', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }], bindings: [{
            id: 'rule', serverId: 'server', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 20,
        }] };
        let revision = 40;
        const usage = UsageMcpBindingUsageSchema.parse({ v: 2, evidenceId: 'mcp-window', sessionId: 'session', turnId: 'turn',
            observedAtMs: 150, window: { startMs: 100, endMs: 150 }, coverage: 'complete', bindings: [{ serverId: 'server',
                bindingId: 'rule', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
        const snapshot = () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
            readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) });
        let raceAfterQuery = false;
        let analyticsAvailable = true;
        let analyticsReads = 0;
        let nextRuleId = 0;
        let preferences = UsageCoachPreferencesV1Schema.parse({});
        let suppressions = UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions: [] });
        let settingsVersion = 1;
        const mcp = createMcpServerActionExecuteV1({ readCatalog: snapshot,
            // Only the durable row transport is replaced; reducers and CAS remain real.
            mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
                ctx: { nowMs: 300, newId: () => `new-rule-${++nextRuleId}` }, writeCatalog: async candidate => {
                    if (expectedRevision !== revision || candidate.expectedRevision !== revision) return { status: 'conflict', revision };
                    catalog = candidate.catalog; return { status: 'updated', revision: ++revision, cursor: revision };
                } }), machine: async () => { throw Error('No machine effect'); },
        });
        const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        // A real unrelated rules mutation advances the same catalog after capture.
        expect(await mcp({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'other-server' }], change: {
            kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' },
        } }, context })).toMatchObject({ ok: true, result: { ok: true, revision: 41 } });
        const original = catalog.bindings;
        const originalBinding = original.find(rule => rule.id === 'rule')!;
        const executor = createActionExecutor({ mcpServerAction: mcp,
            settingsDeclarationAction: async request => {
                if (request.actionId === 'settings.get') return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion };
                preferences = UsageCoachPreferencesV1Schema.parse('value' in request.input ? request.input.value : undefined);
                return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: ++settingsVersion };
            },
            usageActions: { coachSuppressions: () => coachKv(() => suppressions, value => { suppressions = value; }), query: async () => {
                analyticsReads += 1;
                if (!analyticsAvailable) throw new Error('Analytics transport unavailable');
                const finding = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
                    currentness: 'current', detail: { coverage: 'partial', mcpUsage: [usage] } }).findings;
                const admittedRemedies = buildUsageCoachRemedies({ findings: finding, composition: [], mcpUsage: [usage], serverId: 'home',
                    sessions: [{ id: 'session', serverId: 'home', active: false, ownerMetadata: {}, agentTarget: null,
                        access: { capabilities: { submitAgentInput: true } } }], mcpCatalog: await snapshot() });
                const batch = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, asOfMs: 200,
                    detail: { status: 'partial', coach: { detail: { coverage: 'partial', mcpUsage: [usage] }, admittedRemedies } } }] });
                if (raceAfterQuery) { revision += 1; raceAfterQuery = false; }
                return batch;
            } },
        } as ActionExecutorDeps);
        const queried = await executor.execute('usage.query', { queries: [query] }, context);
        expect(queried.ok).toBe(true);
        const evaluation = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, asOfMs: 200,
            detail: { status: 'partial', coach: { detail: { coverage: 'partial', mcpUsage: [usage] } } } }] });
        const evidenceKey = evaluation.results[0]!.coach!.findings.find(row => row.detectorId === 'mcp_overhead')!.evidenceKey;
        const apply = await executor.execute('usage.coach.apply', { query, evidenceKey }, context);
        expect(apply, JSON.stringify(apply)).toMatchObject({ ok: true, result: { kind: 'applied', reversal: { kind: 'mcp_binding' } } });
        if (!apply.ok) throw Error('Apply failed');
        const receipt = UsageCoachApplyResultSchema.parse(apply.result);
        expect(catalog.bindings.find(rule => rule.id === 'rule')!.enabled).toBe(false);
        analyticsAvailable = false;
        analyticsReads = 0;
        const undo = await executor.execute('usage.coach.undo', { query, evidenceKey, reversal: receipt.reversal }, context);
        expect(undo, JSON.stringify(undo)).toMatchObject({ ok: true, result: { kind: 'undone' } });
        const configuration = (rules: McpServerCatalogV1['bindings']) => rules.map(({ updatedAt: _clock, ...rule }) => rule)
            .sort((a, b) => a.id.localeCompare(b.id));
        expect(configuration(catalog.bindings)).toEqual(configuration(original));
        const untilMs = Date.now() + 60_000;
        const snooze = await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs }, context);
        expect(snooze).toMatchObject({ ok: true, result: { kind: 'preference_updated' } });
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, suppressions, untilMs - 1).findings[0]!.state.snoozedUntilMs).toBe(untilMs);
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, suppressions, untilMs).findings[0]!.state.snoozedUntilMs).toBeNull();
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: true }, context)).toMatchObject({ ok: true });
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, suppressions, 250).findings[0]!.state.dismissed).toBe(true);
        expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: false }, context)).toMatchObject({ ok: true });
        expect(applyUsageCoachPreferences(evaluation.results[0]!.coach!, suppressions, 250).findings[0]!.state.dismissed).toBe(false);
        expect(analyticsReads).toBe(0);
        analyticsAvailable = true;
        // New native observation sees the restored configuration and its real row revision.
        usage.bindings[0]!.catalogRevision = revision;
        usage.bindings[0]!.bindingRevision = catalog.bindings.find(rule => rule.id === 'rule')!.updatedAt;
        const reapplied = await executor.execute('usage.coach.apply', { query, evidenceKey }, context);
        expect(reapplied.ok).toBe(true);
        if (!reapplied.ok) throw Error('Reapply failed');
        const nextReceipt = UsageCoachApplyResultSchema.parse(reapplied.result);
        await mcp({ actionId: 'mcp.rules.set', input: { items: [{ serverId: 'server' }], change: {
            kind: 'write', write: { place: { t: 'machine', machineId: 'other-machine' }, state: 'on' },
        } }, context });
        const intervening = catalog;
        analyticsAvailable = false;
        analyticsReads = 0;
        expect(await executor.execute('usage.coach.undo', { query, evidenceKey, reversal: nextReceipt.reversal }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_owner_refused', details: { ok: false, code: 'conflict' } });
        expect(catalog).toBe(intervening);
        expect(analyticsReads).toBe(0);
        analyticsAvailable = true;
        // Apply must also refuse a row changed between the authorized query and effect.
        catalog = { ...catalog, bindings: original }; usage.bindings[0]!.catalogRevision = revision;
        usage.bindings[0]!.bindingRevision = originalBinding.updatedAt; raceAfterQuery = true;
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_owner_refused', details: { ok: false, code: 'conflict' } });
        expect(catalog.bindings).toBe(original);
        // Changing the actual server or rule voids the old witness before mutation.
        catalog = { ...catalog, servers: catalog.servers.map(server => server.id === 'server' ? { ...server, updatedAt: 301 } : server) };
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_remedy_unavailable' });
        catalog = { ...catalog, servers: catalog.servers.map(server => server.id === 'server' ? { ...server, updatedAt: 10 } : server),
            bindings: original.map(rule => rule.id === 'rule' ? { ...rule, updatedAt: 302 } : rule) };
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey }, context))
            .toMatchObject({ ok: false, errorCode: 'coach_remedy_unavailable' });
    });
    it('prepares the canonical rules address from witnessed MCP usage', () => {
        const usage = UsageMcpBindingUsageSchema.parse({ v: 1, evidenceId: 'mcp-window', sessionId: 'session', turnId: 'turn',
            observedAtMs: 150, window: { startMs: 100, endMs: 150 }, coverage: 'complete', bindings: [{ serverId: 'server',
                bindingId: 'rule', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
        const finding = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
            currentness: 'current', detail: { coverage: 'partial', mcpUsage: [usage] } }).findings;
        const input = { findings: finding, composition: [], mcpUsage: [usage], serverId: 'home',
            sessions: [{ id: 'session', serverId: 'home', active: true, ownerMetadata: {}, agentTarget: null,
                access: { capabilities: { submitAgentInput: true } } }],
            mcpCatalog: { status: 'ready', authority: 'active', revision: 40, diagnostics: [], catalog: { v: 1,
                servers: [{ id: 'server', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
                bindings: [{ id: 'rule', serverId: 'server', enabled: true, target: { t: 'allMachines' }, agentId: 'codex', createdAt: 1, updatedAt: 20 }] } },
        } satisfies Parameters<typeof buildUsageCoachRemedies>[0];
        expect(buildUsageCoachRemedies(input)).toEqual([]);
        const currentUsage = UsageMcpBindingUsageSchema.parse({ ...usage, v: 2 });
        const currentFinding = evaluateUsageCoach({ queryKey: 'query', period: { startMs: 100, endMs: 200 }, asOfMs: 200,
            currentness: 'current', detail: { coverage: 'partial', mcpUsage: [currentUsage] } }).findings;
        expect(buildUsageCoachRemedies({ ...input, findings: currentFinding, mcpUsage: [currentUsage] }))
            .toMatchObject([{ remedy: { kind: 'mcp_binding', bindingId: 'rule', serverId: 'server',
            target: { t: 'allMachines' }, agentId: 'codex', enabled: false, expectedRevision: 40 } }]);
    });
    it('forwards private evidence preference Actions to the available answering client owner', async () => {
        const detail = { status: 'partial' as const, permissions: [{ requestId: 'permission', workId: 'work',
            requestedAtMs: 120, decidedAtMs: 160, toolId: null, answeringClientCategory: null }] };
        const batch = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, detail, asOfMs: 200 }] });
        const finding = batch.results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
        let preferences = UsageCoachPreferencesV1Schema.parse({});
        let suppressions = UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions: [] });
        const client = createActionExecutor({ isActionApprovalRequired: () => false,
            usageActions: { query: async () => batch,
                coachSuppressions: () => coachKv(() => suppressions, value => { suppressions = value; }) },
            settingsDeclarationAction: async request => {
                if (request.actionId === 'settings.get') return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: 1 };
                preferences = UsageCoachPreferencesV1Schema.parse('value' in request.input ? request.input.value : undefined);
                return { anchor: 'usage.coachPreferences', value: preferences, settingsVersion: 2 };
            },
        } as ActionExecutorDeps);
        const headless = createActionExecutor({ isActionApprovalRequired: () => false,
            // This transport reaches the existing client Action executor; no private finding crosses in input.
            clientActionExecute: async request => client.execute(request.actionId, request.input, { ...request.context, surface: 'ui' }),
            usageActions: { query: async input => resolveUsagePageAggregation({ queries: input.queries }),
                coachSuppressions: () => coachKv(() => suppressions, value => { suppressions = value; }) },
        } as ActionExecutorDeps);
        const input = { query, evidenceKey: finding.evidenceKey, dismissed: true };
        for (const surface of ['cli', 'agent', 'mcp', 'api'] as const) {
            const result = await headless.execute('usage.coach.dismiss', input,
                { surface, authority: 'present_user' });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                result: { kind: 'preference_updated', evidenceKey: finding.evidenceKey, dismissed: true } });
            expect(suppressions.suppressions).toEqual([{ kind: 'dismissed', evidenceKey: finding.evidenceKey }]);
        }
    });
    it('admits strict evidence references and keeps remedy mutations dangerous', async () => {
        const executor = createActionExecutor({} as ActionExecutorDeps);
        for (const id of ['usage.coach.apply', 'usage.coach.undo'] as const) {
            expect(getActionSpec(id as ActionId).safety).toBe('danger');
        }
        const injectedRemedy = await executor.execute('usage.coach.apply' as ActionId, {
            query, evidenceKey: 'finding', remedy: { kind: 'setting', anchor: 'injected', value: true },
        }, { surface: 'ui' });
        expect(injectedRemedy, JSON.stringify(injectedRemedy)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await executor.execute('usage.coach.apply' as ActionId, {
            query, evidenceKey: 'finding', confirmed: true,
        }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    });
    it('requires normal dangerous-Action approval before reading or applying a valid finding', async () => {
        const executor = createActionExecutor({} as ActionExecutorDeps);
        const admitted = await executor.execute('usage.coach.apply', { query, evidenceKey: 'finding' }, {
            surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    });
    it('reaches evidence admission directly for the present-user UI without an approval host', async () => {
        const executor = createActionExecutor({} as ActionExecutorDeps);
        expect(await executor.execute('usage.coach.apply', { query, evidenceKey: 'finding' }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });
});
