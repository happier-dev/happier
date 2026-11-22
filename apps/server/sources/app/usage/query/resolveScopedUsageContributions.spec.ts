import { describe, expect, it, vi } from "vitest";

import { addUsageCost, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from "../usageMetrics";
import { prepareScopedUsageReplayContext, resolveScopedUsageContributions, type ScopedUsageEventRow } from "./resolveScopedUsageContributions";
import { readScopedUsageAccountingEvidence } from './scopedUsageEventRow';
import { resolveEffectiveUsageCostUsd } from "./resolveUsageCostMode";
import { buildUsageResultProjection } from './buildUsageResultProjection';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { buildUsagePricingPopulation, priceUsagePricingPopulation } from '@happier-dev/protocol/usage/usagePricingPopulation';

function row(id: string, time: number, scope: string, total: number): ScopedUsageEventRow {
    return {
        id, sessionId: "session", agentId: "claude", source: "native",
        observedAt: new Date(time), createdAt: new Date(time), scope,
        isCumulative: scope !== "turn_delta", backendMode: null, modelId: null,
        projectKey: null, workspaceId: null, machineId: null, turnId: null,
        contextUsedTokens: null, contextWindowTokens: null,
        tokens: { ...createEmptyUsageTokens(), input: total, total },
        cost: { ...createEmptyUsageCost(), estimatedUsd: total / 100, costSource: "pricing_estimate" },
    };
}

function requireMeasurement(value: number | null): number {
    if (value === null) throw new Error("Expected a measured fixture value");
    return value;
}

describe("resolveScopedUsageContributions", () => {
    describe('Codex thread accounting', () => {
        const measures = (count: number) => ({ tokens: { input: 100 * count, output: 20 * count,
            cacheRead: 6 * count, cacheWrite: 4 * count, reasoning: 5 * count, total: 120 * count },
            cost: { ...createEmptyUsageCost(), estimatedUsd: 3 * count, costSource: 'pricing_estimate' as const,
                breakdown: { input: 2 * count, output: count } } });
        const fact = (path: 'runtime' | 'native', sequence: number | undefined, at: number, count: number,
            exact = false, stream = 'a'.repeat(64)): ScopedUsageEventRow => ({
            ...row(`fact-${at}`, at, exact ? 'turn_delta' : 'session_cumulative', 120 * count),
            sessionId: path === 'runtime' ? 'happier-session' : null, machineId: 'shared-machine', agentId: 'codex',
            source: path, ...measures(count), modelId: 'gpt-5',
            metadata: { usageAccounting: { path, nativeSessionKey: stream, status: 'available', historyComplete: true,
                inputIncludesCache: true, outputIncludesReasoning: true,
                ...(exact ? { inferenceId: `response-${at}` } : {}),
                ...(sequence === undefined ? {} : { runtimeEventOrder: { runtimeIncarnationId: stream, sequence } }) } },
        });
        const native = (at: number, count: number, stream?: string) => fact('native', undefined, at, count, false, stream);
        const exact = (at: number, count: number, stream?: string) =>
            fact('runtime', at, at, count, true, stream);
        const checkpoint = (at: number, count: number) => fact('runtime', at, at, count);
        const resolve = (facts: readonly ScopedUsageEventRow[], path?: 'native' | 'runtime') => {
            const result = resolveScopedUsageContributions(facts);
            const contributions = path ? result.totalContributions.filter(item => item.source === path) : result.totalContributions;
            const tokens = contributions.reduce((sum, item) => addUsageTokens(sum, item.tokens), createEmptyUsageTokens());
            const costs = contributions.reduce((sum, item) => addUsageCost(sum, item.cost), createEmptyUsageCost());
            return { tokens, cost: { estimatedUsd: costs.estimatedUsd, breakdown: costs.breakdown }, reasons: result.coverageReasons };
        };
        const measure = (actual: ReturnType<typeof resolve>, count: number) => {
            const expected = measures(count);
            expect(actual.tokens).toEqual(expected.tokens);
            expect(actual.cost).toEqual(count
                ? { estimatedUsd: expected.cost.estimatedUsd, breakdown: expected.cost.breakdown }
                : { estimatedUsd: null, breakdown: undefined });
        };

        it('keeps native usage before and after an exact runtime receipt', () => {
            const facts = [native(5, 1), native(10, 2), exact(20, 1), native(25, 3), native(30, 4)];
            measure(resolve(facts), 4);
            measure(resolve(facts, 'runtime'), 0);
            measure(resolve(facts, 'native'), 4);
        });

        it.each([
            ['native before runtime delivery', [native(10, 1), exact(20, 1)]],
            ['native after the final runtime observation', [exact(10, 1), native(20, 1)]],
            ['native and runtime interleaved over three responses', [
                native(10, 1), exact(20, 1), exact(30, 1), native(40, 2), native(50, 3), exact(60, 1),
            ]],
        ] as const)('counts the thread once with %s', (_description, facts) => {
            const result = resolve(facts);
            measure(result, facts.length / 2);
            expect(result.reasons).not.toContain('ambiguous_overlap');
        });

        it('retains a native counter reset across runtime incarnations', () => {
            const resumed = exact(45, 1);
            resumed.metadata = { usageAccounting: {
                path: 'runtime', nativeSessionKey: 'a'.repeat(64),
                inferenceId: 'resumed-response', runtimeEventOrder: { runtimeIncarnationId: 'second', sequence: 1 },
                historyComplete: true,
            } };
            const facts = [native(10, 3), exact(20, 3), native(40, 1), resumed];
            measure(resolve(facts), 4);
            measure(resolve(facts, 'native'), 4);
            measure(resolve(facts, 'runtime'), 0);
        });

        it('keeps a native response when publication is missing, and an exact runtime response absent from native', () => {
            const shared = [native(10, 1), exact(20, 1)];
            measure(resolve([...shared, native(30, 3)]), 3);
            measure(resolve([...shared, native(30, 3)], 'native'), 3);
            measure(resolve([...shared, exact(30, 2)]), 3);
            measure(resolve([...shared, exact(30, 2)], 'runtime'), 2);
        });

        it('prices the known native token share when both sources omit totals', () => {
            const captured = native(20, 1);
            captured.tokens = { ...captured.tokens, cacheRead: 0, reasoning: null, total: null };
            const observed = exact(10, 1);
            observed.tokens = { ...observed.tokens, output: null, cacheRead: null, reasoning: null, total: null };
            observed.cost = createEmptyUsageCost();
            const result = resolve([observed, captured]);
            expect(result.tokens).toEqual({ ...captured.tokens });
            expect(result.cost.estimatedUsd).toBe(0.5);
            expect(result.cost.breakdown?.input).toBeCloseTo(2 / 6);
            expect(result.cost.breakdown?.output).toBeCloseTo(1 / 6);
        });

        it('retains independent token facets and monetary measurements when different sides win', () => {
            const captured = native(20, 1);
            captured.tokens = { ...captured.tokens, output: 70 };
            captured.cost = { ...captured.cost, reportedUsd: 5, invoiceUsd: 1 };
            const observed = exact(10, 2);
            observed.cost = { ...observed.cost, reportedUsd: 2, invoiceUsd: 3 };
            const facts = [observed, captured];
            expect(resolve(facts).tokens).toEqual({ ...observed.tokens, output: 70 });
            expect(resolveScopedUsageContributions(facts).totalContributions
                .reduce((sum, item) => addUsageCost(sum, item.cost), createEmptyUsageCost()))
                .toMatchObject({ reportedUsd: 5, estimatedUsd: 6, invoiceUsd: 3 });
            expect(resolve(facts, 'native').tokens.output).toBe(30);
        });

        it('does not reconcile identical amounts from different opaque streams on one Machine', () => {
            const other = 'b'.repeat(64);
            const facts = [native(10, 1, other), exact(20, 1)];
            measure(resolve(facts), 2);
        });

        it.each([
            ['checkpoint only', [checkpoint(10, 1), native(20, 1)], 2],
            ['runtime and checkpoint order present', [native(10, 1), exact(20, 1), checkpoint(30, 1)], 3],
        ] as const)('keeps all observations with incomplete coverage when runtime has no accounting subject: %s', (_description, facts, total) => {
            const uncorrelated = facts.map(fact => fact.source === 'runtime' ? {
                ...fact, sessionId: null, metadata: { usageAccounting: { path: 'runtime', historyComplete: true } },
            } : fact);
            const result = resolve(uncorrelated);
            measure(result, total);
            expect(result.reasons).toEqual([]);
            const folded = resolveScopedUsageContributions(uncorrelated);
            const projected = buildUsageResultProjection({ contributions: folded.totalContributions,
                evidenceRows: uncorrelated, coverageReasons: folded.coverageReasons,
                request: { granularity: 'day', timeZoneOffsetMinutes: 0, includeSeries: false, topLimit: 20 } });
            expect(projected.coverage.status).toBe('partial');
            expect(projected.coverage.range.complete).toBe(false);
            expect(projected.coverage.reasons).toEqual(expect.arrayContaining(['unknown_source', 'incomplete_history']));
        });
    });

    it('retains the witnessed Pi cumulative model through accounting coverage and catalog pricing', () => {
        // Captured r177 paid counters and attribution; identity, time and occupancy are synthetic.
        const snapshot: ScopedUsageEventRow = { ...row('pi-snapshot', 100, 'session_cumulative', 3309),
            agentId: 'pi', source: 'pi-session-stats', modelId: 'openai/gpt-4.1-mini',
            contextUsedTokens: 3309, contextWindowTokens: 1047576,
            tokens: { input: 3305, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3309 },
            cost: createEmptyUsageCost(),
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true,
                inputIncludesCache: false, outputIncludesReasoning: true } },
        };
        const folded = resolveScopedUsageContributions([snapshot]);
        const projection = buildUsageResultProjection({ contributions: folded.totalContributions,
            evidenceRows: [snapshot], coverageReasons: folded.coverageReasons,
            request: { granularity: 'day', timeZoneOffsetMinutes: 0, includeSeries: false, topLimit: 20 } });
        const priced = priceUsagePricingPopulation(buildUsagePricingPopulation(projection.contributions),
            bundledUsageModelPriceCatalog, {}, 'api_equivalent');
        expect(projection.contributions).toHaveLength(1);
        expect(projection.contributions[0]).toMatchObject({ modelId: snapshot.modelId, tokenCategories: snapshot.tokens });
        expect(projection.coverage.missingDimensions).not.toContain('model');
        expect(projection.coverage.reasons).not.toContain('unattributed_model');
        expect(priced.apiEquivalentUsd).toBeGreaterThan(0);
        expect(priced.facts.some(fact => fact.kind === 'unpriced')).toBe(false);
    });

    it('retains cumulative model witnesses across counter differences without filling a mixed-model snapshot', () => {
        const snapshot = (id: string, time: number, total: number, modelId: string | null) => ({
            ...row(id, time, 'session_cumulative', total), modelId,
            metadata: { usageAccounting: { historyComplete: true } },
        });
        const result = resolveScopedUsageContributions([
            snapshot('first', 100, 10, 'A'), snapshot('same-model', 200, 20, 'A'),
            snapshot('mixed-model', 300, 30, null),
        ]);
        expect(result.totalContributions.map(event => [event.modelId, event.tokens.total]))
            .toEqual([['A', 10], ['A', 10], [null, 10]]);
    });

    it('retains the cumulative residual model when a reported total covers an earlier inference', () => {
        const result = resolveScopedUsageContributions([
            { ...row('inference', 100, 'turn_delta', 10), modelId: 'A' },
            { ...row('snapshot', 200, 'session_cumulative', 20), modelId: 'A',
                metadata: { usageAccounting: { historyComplete: true } },
                cost: { ...createEmptyUsageCost(), reportedUsd: 0.1, costSource: 'provider_reported' } },
        ]);
        expect(result.totalContributions.map(event => [event.modelId, event.tokens.total]))
            .toEqual([['A', 10], ['A', 10], [null, null]]);
    });

    it('does not attribute incomplete cumulative history to its current model hint', () => {
        const result = resolveScopedUsageContributions([
            { ...row('partial', 100, 'session_cumulative', 10), modelId: 'current-model',
                metadata: { usageAccounting: { historyComplete: false } } },
        ]);
        expect(result.totalContributions[0]?.modelId).toBeNull();
    });

    it('keeps child native counters independent from the parent sharing the Happier Session', () => {
        const native = (id: string, time: number, total: number, nativeSessionId: string) => ({ ...row(id, time, 'session_cumulative', total),
            metadata: { usageAccounting: { path: 'runtime', nativeSessionId, status: 'available', historyComplete: true } } });
        const childUnknown = { ...native('child-unknown', 150, 0, 'native-child'),
            tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null },
            cost: { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD' } };
        const result = resolveScopedUsageContributions([
            native('parent-first', 100, 100, 'native-parent'), childUnknown,
            native('child-known', 200, 7, 'native-child'), native('parent-latest', 300, 120, 'native-parent'),
        ]);
        expect(result.totalContributions.map(event => [event.id, event.tokens.total])).toEqual([
            ['parent-first', 100], ['child-unknown', null], ['child-known', 7], ['parent-latest', 20],
        ]);
        expect(result.coverageReasons).not.toContain('counter_discontinuity');
    });
    it('keeps missing-baseline coverage when an initial measured snapshot has no prior deltas', () => {
        expect(resolveScopedUsageContributions([row('snapshot', 100, 'session_cumulative', 100)]).coverageReasons)
            .toContain('missing_baseline');
    });
    it('retains a measured zero cumulative counter as zero rather than unknown', () => {
        const zero = row('zero', 100, 'session_cumulative', 0);
        const result = resolveScopedUsageContributions([zero]);
        expect(result.totalContributions).toHaveLength(1);
        expect(result.totalContributions[0]?.tokens.total).toBe(0);
    });
    it('retains unmeasured snapshots without making them counter baselines or merging child subjects', () => {
        const unknown = (id: string, time: number): ScopedUsageEventRow => ({ ...row(id, time, 'session_cumulative', 0),
            tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null },
            cost: { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD', costSource: 'none' } });
        const result = resolveScopedUsageContributions([
            row('known', 100, 'session_cumulative', 100), unknown('unknown', 200),
            { ...unknown('child', 250), sessionId: 'child-session' }, row('latest', 300, 'session_cumulative', 120),
        ]);
        expect(result.totalContributions.map(event => [event.id, event.tokens.total])).toEqual([
            ['known', 100], ['unknown', null], ['child', null], ['latest', 20],
        ]);
        expect(result.coverageReasons).not.toContain('counter_discontinuity');
    });
    it('retains each measured counter baseline across a partially measured snapshot', () => {
        const partial = { ...row('partial', 200, 'session_cumulative', 0),
            tokens: { input: null, output: 5, reasoning: null, cacheRead: null, cacheWrite: null, total: null },
            cost: { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD' } };
        const result = resolveScopedUsageContributions([
            row('baseline', 100, 'session_cumulative', 100), partial,
            row('latest', 300, 'session_cumulative', 120),
        ]);
        expect(result.totalContributions.map(event => [event.id, event.tokens.total])).toEqual([
            ['baseline', 100], ['partial', null], ['latest', 20],
        ]);
        expect(result.totalContributions.find(event => event.id === 'partial')?.cost.estimatedUsd).toBeNull();
        expect(result.totalContributions.find(event => event.id === 'latest')?.cost.estimatedUsd).toBeCloseTo(0.2);
    });
    it('conserves delta categories across snapshots that omit those counters', () => {
        const baseline = { ...row('baseline', 100, 'session_cumulative', 110),
            tokens: { ...createEmptyUsageTokens(), input: 100, output: 10, total: 110 } };
        const delta = { ...row('delta', 150, 'turn_delta', 8),
            tokens: { ...createEmptyUsageTokens(), input: 5, output: 3, total: 8 } };
        const partial = { ...row('partial', 200, 'session_cumulative', 0),
            tokens: { ...createEmptyUsageTokens(), input: 105 }, cost: createEmptyUsageCost() };
        const latest = { ...row('latest', 300, 'session_cumulative', 121),
            tokens: { ...createEmptyUsageTokens(), input: 107, output: 14, total: 121 } };
        const contributions = resolveScopedUsageContributions([baseline, delta, partial, latest]).totalContributions;
        expect(contributions.find(event => event.id === 'latest')?.tokens).toMatchObject({ input: 2, output: 1, total: 3 });
        expect(contributions.reduce((sum, event) => sum + (event.tokens.output ?? 0), 0)).toBe(14);
        expect(contributions.reduce((sum, event) => sum + (event.tokens.total ?? 0), 0)).toBe(121);
    });
    it('conserves delta money across snapshots that omit the monetary counter', () => {
        const baseline = row('baseline', 100, 'session_cumulative', 100);
        const delta = row('delta', 150, 'turn_delta', 10);
        baseline.cost.breakdown = { input: 1 };
        delta.cost.breakdown = { input: 0.1 };
        const partial = { ...row('partial', 200, 'session_cumulative', 110), cost: createEmptyUsageCost() };
        const latest = row('latest', 300, 'session_cumulative', 120);
        latest.cost.breakdown = { input: 1.2 };
        const contributions = resolveScopedUsageContributions([baseline, delta, partial, latest]).totalContributions;
        expect(contributions.find(event => event.id === 'latest')?.cost.estimatedUsd).toBeCloseTo(0.1);
        expect(contributions.find(event => event.id === 'latest')?.cost.breakdown?.input).toBeCloseTo(0.1);
        expect(contributions.reduce((sum, event) => sum + (event.cost.estimatedUsd ?? 0), 0)).toBeCloseTo(1.2);
    });
    it.each([['witnessed', 0], ['witnessed', 3], ['decrease', 0], ['decrease', 3]] as const)(
        'discards old sparse-snapshot deltas at a %s reset while subtracting %s current-interval tokens', (resetKind, currentDelta) => {
        const before = { usageAccounting: { counterEpoch: 'before' } };
        const after = { usageAccounting: { counterEpoch: 'after' } };
        const baseline = { ...row('baseline', 100, 'session_cumulative', 100), metadata: before };
        const delta = { ...row('delta', 150, 'turn_delta', 10), metadata: before };
        const partial = { ...row('partial', 200, 'session_cumulative', 110), metadata: before,
            tokens: { ...createEmptyUsageTokens(), input: 110 }, cost: createEmptyUsageCost() };
        const reset = { ...row('reset', 300, 'session_cumulative', 20), metadata: resetKind === 'witnessed' ? after : before };
        const current = currentDelta ? [{ ...row('current', 250, 'turn_delta', currentDelta), metadata: after }] : [];
        const result = resolveScopedUsageContributions([baseline, delta, partial, ...current, reset]);
        const resetContribution = result.totalContributions.find(event => event.id === 'reset');
        expect(resetContribution?.tokens.total).toBe(20 - currentDelta);
        expect(resetContribution?.cost.estimatedUsd).toBeCloseTo(0.2 - currentDelta / 100);
        expect(result.totalContributions.reduce((sum, event) => sum + (event.tokens.total ?? 0), 0)).toBe(130);
        expect(result.totalContributions.reduce((sum, event) => sum + (event.cost.estimatedUsd ?? 0), 0)).toBeCloseTo(1.3);
        expect(result.coverageReasons.includes('counter_discontinuity')).toBe(resetKind === 'decrease');
    });
    it('keeps the released residue at the report cutoff and later usage in full', () => {
        const legacy = { ...row('legacy', 2, 'turn_delta', 10), source: 'legacy_usage_report', agentId: 'legacy' };
        const before = row('before', 1, 'turn_delta', 3);
        const after = row('after', 3, 'turn_delta', 5);
        const otherSession = { ...row('other', 1, 'turn_delta', 10), sessionId: 'other' };
        const rows = [legacy, before, after, otherSession];
        const replay = prepareScopedUsageReplayContext(rows, { startMs: 2, endMs: 4 });
        const result = resolveScopedUsageContributions(rows, { startMs: 2, endMs: 4 }, replay);
        expect(result.totalContributions.map(row => [row.id, row.tokens.total])).toEqual([['legacy', 7], ['after', 5]]);
        expect(result.coverageReasons).toContain('missing_baseline');
    });
    it('keeps released zero cache reads and zero reported USD when modern measurements are absent', () => {
        const legacy = { ...row('legacy', 2, 'turn_delta', 100), source: 'legacy_usage_report', agentId: 'legacy',
            tokens: { ...createEmptyUsageTokens(), input: 100, cacheRead: 0, total: 100 },
            cost: { ...createEmptyUsageCost(), reportedUsd: 0, costSource: 'provider_reported' as const } };
        const modern = { ...row('modern', 1, 'turn_delta', 100), cost: createEmptyUsageCost() };
        const result = resolveScopedUsageContributions([modern, legacy]);
        const tokens = result.totalContributions.reduce((sum, item) => addUsageTokens(sum, item.tokens), createEmptyUsageTokens());
        const cost = result.totalContributions.reduce((sum, item) => addUsageCost(sum, item.cost), createEmptyUsageCost());
        expect(tokens).toEqual({ ...createEmptyUsageTokens(), input: 100, cacheRead: 0, total: 100 });
        expect(cost).toMatchObject({ reportedUsd: 0, estimatedUsd: null, invoiceUsd: null });
        expect(result.coverageReasons).toContain('missing_baseline');
    });
    it('keeps all-zero Codex occupancy out of the thread counter', () => {
        const checkpoint = (id: string, at: number, total: number) => ({
            ...row(id, at, 'session_cumulative', total),
            agentId: 'codex', source: 'runtime', machineId: 'shared-machine',
            metadata: { usageAccounting: { path: 'runtime', nativeSessionKey: 'a'.repeat(64),
                historyComplete: true, counterEpoch: 'unchanged' } },
        });
        const result = resolveScopedUsageContributions([
            checkpoint('before', 100, 100),
            { ...checkpoint('occupancy', 200, 0), contextUsedTokens: 25, contextWindowTokens: 1000,
                tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 } },
            checkpoint('after', 300, 110),
        ]);
        expect(result.bucketAttributions.map(event => [event.id, event.tokens.total])).toEqual([
            ['before', 100], ['occupancy', 0], ['after', 10],
        ]);
        expect(result.bucketAttributions[1]).toMatchObject({ contextUsedTokens: 25, contextWindowTokens: 1000 });
        expect(result.coverageReasons).toEqual([]);
    });
    it.each([
        ['session_cumulative', 100, 0, []],
        ['session_cumulative', 113, 13, []],
        ['turn_delta', 100, 0, []],
        ['turn_delta', 113, 13, ['missing_baseline']],
    ] as const)('uses earlier Codex %s evidence for resume at %i', (scope, total, increase, reasons) => {
        const nativeSessionKey = 'a'.repeat(64);
        const native = {
            ...row('native', 100, scope, 100), agentId: 'codex', machineId: 'shared-machine',
            metadata: { usageAccounting: { path: 'native', nativeSessionKey, historyComplete: true } },
        };
        const runtime = {
            ...row('runtime', 200, 'session_cumulative', total),
            agentId: 'codex', source: 'runtime', machineId: 'shared-machine',
            metadata: { usageAccounting: { path: 'runtime', nativeSessionKey } },
        };
        const result = resolveScopedUsageContributions([native, runtime]);
        const resume = result.bucketAttributions.find(event => event.id === runtime.id);
        expect(resume?.tokens.total ?? 0).toBe(increase);
        expect(resume?.coverageReasons ?? []).toEqual(reasons);
        expect(result.coverageReasons).toEqual(reasons);
    });
    const tokenFields = Object.keys(createEmptyUsageTokens()) as (keyof ScopedUsageEventRow['tokens'])[];
    const costFields = ['reportedUsd', 'invoiceUsd'] as const;
    it.each([...tokenFields, ...costFields, 'breakdown'] as const)(
        'marks only the unexplained first-checkpoint excess for %s', field => {
            const nativeSessionKey = 'a'.repeat(64);
            const amount = (value: number) => ({
                tokens: tokenFields.includes(field as typeof tokenFields[number])
                    ? { ...createEmptyUsageTokens(), [field]: value } : createEmptyUsageTokens(),
                cost: { ...createEmptyUsageCost(), ...(field === 'breakdown'
                    ? { costSource: 'provider_reported' as const, breakdown: { input: value } }
                    : costFields.includes(field as typeof costFields[number]) ? { [field]: value } : {}) },
            });
            const native = {
                ...row('exact', 100, 'turn_delta', 0), agentId: 'codex', machineId: 'shared-machine',
                ...amount(100),
                metadata: { usageAccounting: { path: 'native', nativeSessionKey, inferenceId: 'exact-response' } },
            };
            const checkpoint = {
                ...row('checkpoint', 200, 'session_cumulative', 0), agentId: 'codex', machineId: 'shared-machine',
                source: 'runtime', metadata: { usageAccounting: { path: 'runtime', nativeSessionKey } },
            };
            for (const [measured, excess] of [[90, 0], [100, 0], [113, 13]] as const) {
                const result = resolveScopedUsageContributions([native, { ...checkpoint, ...amount(measured) }]);
                const reasons = excess ? ['missing_baseline'] : [];
                expect(result.coverageReasons).toEqual(reasons);
                const resumed = result.bucketAttributions.find(event => event.id === checkpoint.id);
                if (excess) {
                    expect(resumed).toMatchObject({ ...amount(excess), coverageReasons: reasons });
                } else {
                    expect(resumed).toBeUndefined();
                }
            }
        });
    it.each([
        ['gpt-5.4-mini', 0.0001065, 'gpt-5.4', 0.000355],
        ['gpt-5.4', 0.000355, 'gpt-5.4-mini', 0.0001065],
    ] as const)('keeps a covered first checkpoint diagnostic-free when repriced from %s', (priorModel, prior, nextModel, next) => {
        const nativeSessionKey = 'a'.repeat(64);
        const estimate = (estimatedUsd: number) => ({
            ...createEmptyUsageCost(), estimatedUsd, costSource: 'pricing_estimate' as const,
            breakdown: { input: estimatedUsd },
        });
        const tokens = { input: 90, output: 20, cacheRead: 6, cacheWrite: 0, reasoning: 4, total: 110 };
        const native = {
            ...row('exact', 100, 'turn_delta', 110), agentId: 'codex', machineId: 'shared-machine',
            modelId: priorModel, tokens, cost: estimate(prior),
            metadata: { usageAccounting: { path: 'native', nativeSessionKey, inferenceId: 'exact-response' } },
        };
        const runtime = {
            ...row('checkpoint', 200, 'session_cumulative', 110), agentId: 'codex', machineId: 'shared-machine',
            modelId: nextModel, tokens, source: 'runtime', cost: estimate(next),
            metadata: { usageAccounting: { path: 'runtime', nativeSessionKey } },
        };
        const result = resolveScopedUsageContributions([native, runtime]);
        const aggregate = result.totalContributions.reduce((sum, item) => addUsageCost(sum, item.cost), createEmptyUsageCost());
        expect(aggregate.estimatedUsd).toBe(prior);
        expect(result.totalContributions.reduce((sum, item) => sum + (item.tokens.total ?? 0), 0)).toBe(110);
        expect(result.coverageReasons).toEqual([]);
    });
    it.each(['claude', 'codex'])('retains the %s single-source checkpoint estimate and reconciles mixed evidence', agentId => {
        const checkpoint = (time: number, tokens: number, estimatedUsd: number,
            path: 'native' | 'runtime' = 'native'): ScopedUsageEventRow => ({
            ...row(String(time), time, 'session_cumulative', tokens), agentId, machineId: 'shared-machine',
            metadata: { usageAccounting: { path, nativeSessionKey: 'a'.repeat(64), historyComplete: true } },
            cost: { ...createEmptyUsageCost(), estimatedUsd, costSource: 'pricing_estimate', breakdown: { input: estimatedUsd } },
        });
        const checkpoints = [checkpoint(100, 100, 1), checkpoint(200, 150, 3), checkpoint(300, 150, 6)];
        const single = resolveScopedUsageContributions(checkpoints);
        expect(single.totalContributions.map(event => [event.tokens.total, event.cost.estimatedUsd]))
            .toEqual([[100, 1], [50, 2], [0, 3]]);
        expect(single.coverageReasons).toEqual([]);

        const result = resolveScopedUsageContributions([...checkpoints, checkpoint(150, 100, 1, 'runtime')]);
        expect(result.totalContributions.map(event => [event.tokens.total, event.cost.estimatedUsd])).toEqual([[100, 1], [50, 2]]);
        expect(result.totalContributions[1]?.cost.breakdown?.input).toBeCloseTo(2);
        expect(result.coverageReasons).toEqual([]);
    });
    it('orders each accounting population once rather than once per identical output shape', () => {
        const rows = Array.from({ length: 74_212 }, (_, index) => ({ ...row(`event-${index}`, index, 'turn_delta', 1),
            sessionId: `session-${index % 3_623}` }));
        // Call through the native collection boundary; count elements submitted to sorting,
        // independent of the engine's comparison algorithm and wall-clock performance.
        const sort = vi.spyOn(Array.prototype, 'sort');
        let sortedEvents = 0;
        let result: ReturnType<typeof resolveScopedUsageContributions>;
        try {
            result = resolveScopedUsageContributions(rows);
            for (const values of sort.mock.contexts) {
                if (Array.isArray(values) && values.length > 0 && typeof values[0] === 'object'
                    && values[0] !== null && 'observedAt' in values[0]) sortedEvents += values.length;
            }
        } finally { sort.mockRestore(); }
        expect(result.totalContributions).toHaveLength(rows.length);
        expect(result.bucketAttributions).toEqual(result.totalContributions);
        expect(result.totalContributions.map(event => event.id)).toEqual(rows.map(event => event.id));
        expect(sortedEvents, 'one replay order, one subject input order and one merged contribution order').toBeLessThanOrEqual(3 * rows.length);
    });
    it('folds a single accounting subject wider than the JavaScript call argument limit', () => {
        const rows = Array.from({ length: 140_000 }, (_, index) => row(`event-${index}`, index, 'turn_delta', 1));
        const result = resolveScopedUsageContributions(rows);
        expect(result.totalContributions).toHaveLength(rows.length);
        expect(result.totalContributions[0]?.id).toBe('event-0');
        expect(result.totalContributions.at(-1)?.id).toBe('event-139999');
    });
    it('preserves global same-instant runtime ranks when unrelated subject bodies are omitted', () => {
        const ordered = (id: string, scope: string, total: number, createdAt: number, runtime: string, sequence: number) => ({
            ...row(id, 100, scope, total), source: 'runtime', createdAt: new Date(createdAt),
            metadata: { usageAccounting: { path: 'runtime', runtimeEventOrder: { runtimeIncarnationId: runtime, sequence } } },
        });
        const rows = [
            ordered('selected-snapshot', 'session_cumulative', 100, 101, 'runtime-x', 2),
            ordered('selected-delta', 'turn_delta', 10, 102, 'runtime-y', 1),
            { ...ordered('unrelated-peer', 'turn_delta', 7, 103, 'runtime-x', 1), sessionId: 'other-session' },
            row('selected-latest', 200, 'session_cumulative', 120),
        ].map(event => ({ ...event, accountingEvidence: readScopedUsageAccountingEvidence(event) }));
        const range = { startMs: 175, endMs: 225 };
        const expected = resolveScopedUsageContributions(rows, range);
        expect(expected.totalContributions.map(event => [event.id, event.tokens.total])).toEqual([['selected-latest', 20]]);
        const context = prepareScopedUsageReplayContext(rows, range);
        expect([...context.selectedEventIds]).toEqual(['selected-snapshot', 'selected-delta', 'selected-latest']);
        const selected = rows.filter(event => context.selectedEventIds.has(event.id));
        expect(resolveScopedUsageContributions(selected, range, context)).toEqual(expected);
    });

    it("does not reset an inference counter when an intervening context snapshot carries no billed usage", () => {
        const context = { ...row("context", 200, "session_cumulative", 0),
            contextUsedTokens: 25, contextWindowTokens: 1000 };
        const result = resolveScopedUsageContributions([
            row("baseline", 100, "session_cumulative", 100),
            context,
            row("latest", 300, "session_cumulative", 120),
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(120);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.cost.estimatedUsd), 0)).toBeCloseTo(1.2);
        expect(result.totalContributions.find(event => event.id === "context")).toMatchObject({
            contextUsedTokens: 25, contextWindowTokens: 1000, tokens: { total: 0 },
        });
        expect(result.coverageReasons).not.toContain("counter_discontinuity");
    });

    it("reconciles paid context independently from inference snapshots and replay", () => {
        const paid = (id: string, time: number, total: number, reportedUsd: number, scope = "session_cumulative") => ({
            ...row(id, time, scope, total),
            cost: { ...createEmptyUsageCost(), reportedUsd, costSource: "provider_reported" as const },
        });
        const first = { ...paid("first", 100, 100, 0.1, "turn_delta"),
            metadata: { usageAccounting: { path: "runtime", inferenceId: "first" } } };
        const result = resolveScopedUsageContributions([
            first,
            { ...paid("paid-context", 200, 0, 0.25), contextUsedTokens: 140, contextWindowTokens: 1000 },
            paid("second", 250, 20, 0.05, "turn_delta"),
            paid("measured-total", 300, 120, 0.3),
            { ...paid("latest-paid-context", 400, 0, 0.5), contextUsedTokens: 25, contextWindowTokens: 1000 },
            { ...first, id: "replayed-first", source: "native", observedAt: new Date(500), createdAt: new Date(500),
                metadata: { usageAccounting: { path: "native", inferenceId: "first" } } },
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(120);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.cost.reportedUsd), 0)).toBeCloseTo(0.5);
        expect(result.totalContributions.filter(event => event.contextUsedTokens != null).at(-1)).toMatchObject({
            contextUsedTokens: 25, contextWindowTokens: 1000,
        });
        expect(result.coverageReasons).not.toContain("ambiguous_overlap");
        expect(result.coverageReasons).not.toContain("counter_discontinuity");
    });

    it("keeps inference replay deduplication when a zero-usage inference also carries context", () => {
        const inference = { ...row("runtime", 100, "turn_delta", 0), requestCount: 1,
            contextUsedTokens: 25, contextWindowTokens: 1000 };
        const result = resolveScopedUsageContributions([
            { ...inference, metadata: { usageAccounting: { path: "runtime", inferenceId: "empty" } } },
            { ...inference, id: "native", source: "native", createdAt: new Date(101),
                metadata: { usageAccounting: { path: "native", inferenceId: "empty" } } },
        ]);
        expect(result.totalContributions.map(event => event.id)).toEqual(["runtime"]);
    });

    it("retains reported money on a context snapshot without inventing billed tokens", () => {
        const result = resolveScopedUsageContributions([{
            ...row("context-with-cost", 100, "session_cumulative", 0),
            contextUsedTokens: 25, contextWindowTokens: 1000,
            cost: { ...createEmptyUsageCost(), reportedUsd: 0.25, costSource: "provider_reported" },
        }]);
        expect(result.totalContributions).toHaveLength(1);
        expect(result.totalContributions[0]).toMatchObject({
            contextUsedTokens: 25, tokens: { total: 0 }, cost: { reportedUsd: 0.25 },
        });
    });

    it("reconciles response deltas against the same-millisecond cumulative snapshot regardless of ingestion order", () => {
        const order = (sequence: number) => ({ usageAccounting: { path: 'runtime', runtimeEventOrder: { runtimeIncarnationId: 'runtime', sequence } } });
        const snapshot = { ...row("snapshot", 100, "session_cumulative", 1006), createdAt: new Date(101), metadata: order(3) };
        const first = { ...row("first", 100, "turn_delta", 3), createdAt: new Date(102),
            metadata: order(1) };
        const second = { ...row("second", 100, "turn_delta", 3), createdAt: new Date(103),
            metadata: order(2) };
        const result = resolveScopedUsageContributions([snapshot, first, second]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(1006);
        expect(result.totalContributions.filter(event => event.scope === 'turn_delta').map(event => event.tokens.total)).toEqual([3, 3]);
    });

    it('retains multiple same-clock counter prefixes while leaving other streams and legacy slots stable', () => {
        const ordered = (id: string, scope: string, total: number, sequence: number, created: number): ScopedUsageEventRow => ({
            ...row(id, 100, scope, total), createdAt: new Date(created),
            metadata: { usageAccounting: { path: 'runtime', runtimeEventOrder: { runtimeIncarnationId: 'runtime-A', sequence } } },
        });
        const rows = [row('baseline', 1, 'session_cumulative', 1000),
            ordered('second-snapshot', 'session_cumulative', 1006, 4, 1),
            { ...row('other', 100, 'turn_delta', 0), createdAt: new Date(2), metadata: { usageAccounting: {
                path: 'runtime', runtimeEventOrder: { runtimeIncarnationId: 'runtime-B', sequence: 1 },
            } } },
            ordered('second-response', 'turn_delta', 3, 3, 3),
            { ...row('legacy', 100, 'turn_delta', 0), createdAt: new Date(4) },
            ordered('first-snapshot', 'session_cumulative', 1003, 2, 5),
            ordered('first-response', 'turn_delta', 3, 1, 6)];
        const selected = resolveScopedUsageContributions(rows, { startMs: 100, endMs: 101 });
        expect(selected.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(6);
        expect(selected.totalContributions.filter(event => event.scope === 'turn_delta').map(event => event.id))
            .toEqual(['first-response', 'other', 'legacy', 'second-response']);
        expect(resolveScopedUsageContributions([...rows].reverse(), { startMs: 100, endMs: 101 })).toEqual(selected);
    });

    it("assigns a shared range boundary only to the following half-open period", () => {
        const events = [row("before", 999, "turn_delta", 5), row("boundary", 1000, "turn_delta", 10), row("end", 2000, "turn_delta", 20)];
        const previous = resolveScopedUsageContributions(events, { startMs: 0, endMs: 1000 });
        const current = resolveScopedUsageContributions(events, { startMs: 1000, endMs: 2000 });
        expect(previous.totalContributions.map(event => event.id)).toEqual(["before"]);
        expect(current.totalContributions.map(event => event.id)).toEqual(["boundary"]);
        expect(resolveScopedUsageContributions([row("zero", 0, "turn_delta", 1)], { startMs: 0, endMs: 0 }).totalContributions).toEqual([]);
    });
    it("uses pre-range snapshots as baselines without making them period events", () => {
        const result = resolveScopedUsageContributions([
            row("baseline", 100, "session_cumulative", 100),
            row("selected", 200, "session_cumulative", 120),
        ], { startMs: 150, endMs: 250 });
        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([20]);
        expect(result.totalContributions.flatMap((event) => event.contributingEventIds)).toEqual(["selected"]);
        expect(result.bucketAttributions).toEqual(result.totalContributions);
    });

    it("keeps pre-range replay evidence even when the latest cumulative baseline is unchanged", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.claude", localId: "claude" },
            sourceRootKey: "root", nativeSessionKey: "native" };
        const runtime = { ...row("runtime", 100, "turn_delta", 10), source: "runtime",
            metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "inference", path: "runtime" } } };
        const baseline = { ...row("baseline", 150, "session_cumulative", 100), metadata: { accountingSubject: subject } };
        const native = { ...row("native", 200, "turn_delta", 10), sessionId: null,
            metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "inference", path: "native" } } };
        const range = { startMs: 175, endMs: 225 };

        expect(resolveScopedUsageContributions([runtime, baseline, native], range).totalContributions).toEqual([]);
        const withoutReplay = resolveScopedUsageContributions([baseline, native], range);
        expect(withoutReplay.totalContributions.map((event) => [event.id, event.tokens.total, event.cost.estimatedUsd]))
            .toEqual([["native", 10, 0.1]]);
    });

    it("keeps model and inference attribution and assigns only final residual to unknown model", () => {
        const result = resolveScopedUsageContributions([
            { ...row("a", 100, "turn_delta", 30), modelId: "A", turnId: "a" },
            { ...row("b", 200, "turn_delta", 40), modelId: "B", turnId: "b" },
            { ...row("final", 300, "session_final", 80), modelId: "B" },
        ]);
        expect(result.totalContributions.map((event) => [event.modelId, event.tokens.total])).toEqual([
            ["A", 30], ["B", 40], [null, 10],
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(80);
    });

    it("reconciles witnessed inference replay once, without deduping different inferences in one turn", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.claude", localId: "claude" }, sourceRootKey: "root", nativeSessionKey: "native" };
        const result = resolveScopedUsageContributions([
            { ...row("runtime", 100, "turn_delta", 30), source: "runtime", turnId: "turn", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "runtime" } } },
            { ...row("native", 100, "turn_delta", 30), sessionId: null, source: "native", createdAt: new Date(101), metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...row("second", 200, "turn_delta", 20), source: "runtime", turnId: "turn", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "two", path: "runtime" } } },
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(50);
        expect(result.totalContributions.map((event) => [event.id, event.sessionId])).toEqual([["runtime", "session"], ["second", "session"]]);
    });

    it("keeps different admitted roots, machines and unwitnessed inferences separate from Session replay", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.claude", localId: "claude" }, sourceRootKey: "root", nativeSessionKey: "native" };
        const runtime = { ...row("runtime", 100, "turn_delta", 30), source: "runtime", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "runtime" } } };
        const native = { ...runtime, id: "native", sessionId: null, source: "native", createdAt: new Date(101) };
        const result = resolveScopedUsageContributions([
            runtime,
            { ...native, metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...native, id: "other-root", metadata: { accountingSubject: { ...subject, sourceRootKey: "other-root" }, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...native, id: "other-machine", metadata: { accountingSubject: { ...subject, machineId: "other-machine" }, usageAccounting: { inferenceId: "one", path: "native" } } },
            { ...native, id: "other-inference", metadata: { accountingSubject: subject, usageAccounting: { inferenceId: "two", path: "native" } } },
            { ...native, id: "unwitnessed", metadata: { accountingSubject: subject, usageAccounting: { path: "native" } } },
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(150);
        expect(result.totalContributions.filter((event) => event.sessionId !== null).map((event) => event.id)).toEqual(["runtime"]);
    });

    it("preserves prior spend and exposes unexplained counter discontinuity", () => {
        const result = resolveScopedUsageContributions([
            row("before", 100, "session_cumulative", 100),
            row("reset", 200, "session_cumulative", 20),
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(120);
        expect(result.coverageReasons).toContain("counter_discontinuity");
    });

    it("does not merge unrelated subjects whose Session is absent", () => {
        const result = resolveScopedUsageContributions([
            { ...row("one", 100, "session_cumulative", 100), sessionId: null, metadata: { usageAccounting: { nativeSessionId: "one" } } },
            { ...row("two", 200, "session_cumulative", 20), sessionId: null, metadata: { usageAccounting: { nativeSessionId: "two" } } },
        ]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(120);
    });

    it("reconciles the admitted native subject without merging distinct source roots", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.codex", localId: "codex" }, sourceRootKey: "root-one", nativeSessionKey: "native-one" };
        const result = resolveScopedUsageContributions([
            { ...row("one", 100, "session_cumulative", 100), sessionId: null, metadata: { accountingSubject: subject } },
            { ...row("one-next", 200, "session_cumulative", 120), sessionId: null, metadata: { accountingSubject: subject } },
            { ...row("different-root", 300, "session_cumulative", 50), sessionId: null, metadata: { accountingSubject: { ...subject, sourceRootKey: "root-two" } } },
        ]);
        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([100, 20, 50]);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(170);
    });

    it("counts deltas from a later interrupted turn after the latest final", () => {
        const result = resolveScopedUsageContributions([
            row("covered-delta", 1, "turn_delta", 5),
            row("old-final", 2, "session_final", 10),
            { ...row("covered-later-delta", 3, "turn_delta", 8), metadata: { usageAccounting: { inferenceId: "same" } } },
            row("latest-final", 4, "session_final", 20),
            row("interrupted-delta", 5, "turn_delta", 7),
            // A historical row delivered after the final still belongs before its coverage boundary.
            { ...row("late-replay", 3, "turn_delta", 8), createdAt: new Date(6), metadata: { usageAccounting: { inferenceId: "same" } } },
        ]);

        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(27);
        expect(result.bucketAttributions.reduce((sum, event) => sum + requireMeasurement(event.tokens.total), 0)).toBe(27);
        expect(result.totalContributions.reduce((sum, event) => sum + requireMeasurement(event.cost.estimatedUsd), 0)).toBeCloseTo(0.27);
        expect(result.bucketAttributions.reduce((sum, event) => sum + requireMeasurement(resolveEffectiveUsageCostUsd(event.cost, "auto")), 0)).toBeCloseTo(0.27);
        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([5, 5, 8, 2, 7]);
    });

    it("retains inference attribution and counts only snapshot residual", () => {
        const result = resolveScopedUsageContributions([
            row("delta", 1, "turn_delta", 5),
            row("older", 2, "session_cumulative", 10),
            row("latest", 3, "session_cumulative", 20),
        ]);

        expect(result.totalContributions.map((event) => event.tokens.total)).toEqual([5, 5, 10]);
        expect(result.bucketAttributions).toEqual(result.totalContributions);
    });
});
