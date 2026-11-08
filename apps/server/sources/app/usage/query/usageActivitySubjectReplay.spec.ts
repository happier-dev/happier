import { describe, expect, it } from 'vitest';
import { createEmptyUsageCost, createEmptyUsageTokens } from '../usageMetrics';
import { readScopedUsageAccountingEvidence } from './scopedUsageEventRow';
import { orderRuntimeObservations, resolveScopedUsageContributions, toScopedUsageReplayFact, type ResolvedScopedUsageContributions, type ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { projectScopedUsageContribution } from './buildUsageResultProjection';
import { createUsageActivitySubjectReplay, type UsageActivitySubjectReplayEntry } from './usageActivitySubjectReplay';
import { readUsageMoney, usageMoneyToNumber, withUsageMoney } from '@happier-dev/protocol/usage/usageMoney';

function row(id: string, sessionId: string, time: number, total: number,
    scope = 'turn_delta', metadata: unknown = { usageAccounting: { path: 'runtime' } }): ScopedUsageEventRow {
    const value: ScopedUsageEventRow = { id, sessionId, observedAt: new Date(time), createdAt: new Date(time),
        agentId: 'claude', source: 'runtime', scope, isCumulative: scope !== 'turn_delta',
        backendMode: null, modelId: null, projectKey: null, workspaceId: null, machineId: null, turnId: null,
        contextUsedTokens: null, contextWindowTokens: null, metadata,
        tokens: { ...createEmptyUsageTokens(), input: total, total },
        cost: { ...createEmptyUsageCost(), estimatedUsd: total / 100, costSource: 'pricing_estimate' } };
    return { ...value, accountingEvidence: readScopedUsageAccountingEvidence(value) };
}

function persisted(entries: ReadonlyMap<string, UsageActivitySubjectReplayEntry>) {
    // Exercise the exact producer's JSON checkpoint at its internal persistence boundary.
    const values: Array<[string, UsageActivitySubjectReplayEntry]> = JSON.parse(JSON.stringify([...entries]));
    return new Map(values);
}

function projected(result: ResolvedScopedUsageContributions) {
    return result.preparedContributions ?? result.totalContributions.map(projectScopedUsageContribution);
}

function expectSameProjection(actual: ResolvedScopedUsageContributions, expected: ResolvedScopedUsageContributions) {
    expect(JSON.stringify(projected(actual))).toBe(JSON.stringify(projected(expected)));
    expect(actual.coverageReasons).toEqual(expected.coverageReasons);
}

function observeTokens(rows: readonly ScopedUsageEventRow[]) {
    let reads = 0;
    for (const value of rows) {
        const tokens = value.tokens;
        Object.defineProperty(value, 'tokens', { enumerable: true, get: () => { reads++; return tokens; } });
    }
    return { count: () => reads, reset: () => { reads = 0; } };
}

describe('Usage activity subject replay', () => {
    it('plans from small source facts and restores canonical projected outputs without source bodies', () => {
        const first = row('first', 'selected', 10, 10, 'turn_delta', { usageAccounting: { path: 'runtime',
            inputIncludesCache: true }, usageAttribution: { v: 1, turnId: 'turn', source: { kind: 'native',
                connectedAccount: null, accountScope: 'personal' } }, diagnostic: 'private'.repeat(2048) });
        first.turnId = 'turn';
        first.modelId = 'fixture-model';
        first.tokens = withUsageMoney({ ...first.tokens, cacheRead: 2 },
            { input: { units: 100000000000000001n, scale: 16 } });
        const report = row('report', 'selected', 20, 15, 'session_cumulative');
        report.cost = withUsageMoney({ ...createEmptyUsageCost(), reportedUsd: 0.3,
            costSource: 'provider_reported' }, { reportedUsd: { units: 30000000000000001n, scale: 17 } });
        const rows = [first, report];
        const fingerprints = new Map(rows.map(value => [value.id, 'original']));
        const cold = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints });
        const plan = cold.plan(rows.map(toScopedUsageReplayFact));
        expect(plan.subjects.map(value => value.needsReplay)).toEqual([true]);
        const ranks = new Map(plan.replayContext.ranks);
        cold.resolvePlanned(plan.subjects[0]!, rows, ranks);
        const stored = persisted(cold.entries);
        expect(JSON.stringify([...stored]), 'checkpoint must contain no raw diagnostic metadata').not.toContain('diagnostic');
        const warm = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints, retained: stored });
        const warmPlan = warm.plan(rows.map(toScopedUsageReplayFact));
        expect(warmPlan.subjects.map(value => value.needsReplay)).toEqual([false]);
        const restored = warm.resolvePlanned(warmPlan.subjects[0]!, undefined, new Map(warmPlan.replayContext.ranks));
        const expected = resolveScopedUsageContributions(rows).totalContributions.map(projectScopedUsageContribution);
        expect(JSON.stringify(restored.preparedContributions)).toBe(JSON.stringify(expected));
        expect(restored.totalContributions.every(value => value.metadata === undefined && value.accountingEvidence === undefined)).toBe(true);
        expect(readUsageMoney(restored.preparedContributions[0]!.tokens, 'input', first.tokens.input))
            .toEqual({ units: 100000000000000001n, scale: 16 });
        expect(readUsageMoney(restored.preparedContributions[0]!.tokenCategories!, 'input', 8))
            .toEqual(readUsageMoney(expected[0]!.tokenCategories!, 'input', 8));
        expect(warm.stats).toEqual({ subjectCount: 1, replayedSubjects: 0, replayedEvents: 0 });
    });

    it('invalidates only changed subject facts before hydration and preserves backward replacement', () => {
        const native = row('native', 'selected', 1, 10, 'turn_delta', { usageAccounting: { path: 'native', inferenceId: 'same' } });
        const baseline = row('baseline', 'selected', 2, 20, 'session_cumulative');
        const untouched = row('untouched', 'other', 3, 5);
        const before = [native, baseline, untouched];
        const fingerprints = new Map(before.map(value => [value.id, 'original']));
        const cold = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints });
        const beforePlan = cold.plan(before.map(toScopedUsageReplayFact));
        for (const subject of beforePlan.subjects) cold.resolvePlanned(subject,
            before.filter(value => subject.eventIds.includes(value.id)), new Map(beforePlan.replayContext.ranks));
        const runtime = row('runtime', 'selected', 86_400_001, 10, 'turn_delta', { usageAccounting: { path: 'runtime', inferenceId: 'same' } });
        const after = [...before, runtime];
        const replay = createUsageActivitySubjectReplay({ sourceFingerprints: new Map([...fingerprints, [runtime.id, 'added']]), retained: persisted(cold.entries) });
        const plan = replay.plan(after.map(toScopedUsageReplayFact));
        expect(plan.subjects.filter(value => value.needsReplay).map(value => value.eventIds)).toEqual([['native', 'baseline', 'runtime']]);
        const ranks = new Map(plan.replayContext.ranks);
        const results = plan.subjects.flatMap(subject => replay.resolvePlanned(subject,
            subject.needsReplay ? after.filter(value => subject.eventIds.includes(value.id)) : undefined, ranks).preparedContributions);
        results.sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)! || left.id.localeCompare(right.id));
        expect(JSON.stringify(results)).toBe(JSON.stringify(resolveScopedUsageContributions(after).totalContributions.map(projectScopedUsageContribution)));
        expect(replay.stats).toEqual({ subjectCount: 2, replayedSubjects: 1, replayedEvents: 3 });
    });
    it('reuses persisted projected facts without reading source bodies and restores derived output ranks', () => {
        const rows = [row('delta', 'first', 10, 10), row('report', 'first', 20, 15, 'session_cumulative'),
            row('other', 'second', 30, 7)];
        rows[0]!.cost = withUsageMoney({ ...rows[0]!.cost,
            breakdown: withUsageMoney({ input: 0.1 }, { input: { units: 10000000000000001n, scale: 17 } }) },
            { estimatedUsd: { units: 10000000000000001n, scale: 17 } });
        rows[1]!.cost = { ...createEmptyUsageCost(), reportedUsd: 2, costSource: 'provider_reported' };
        rows[1]!.modelId = 'fixture-model';
        rows[1]!.turnId = 'fixture-turn';
        const fingerprints = new Map(rows.map(value => [value.id, 'original']));
        const cold = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints });
        const expected = resolveScopedUsageContributions(rows, undefined, undefined, cold);
        expect(cold.stats).toEqual({ subjectCount: 2, replayedSubjects: 2, replayedEvents: 3 });
        const earlier = row('earlier', 'third', 1, 3);
        const changedRanks = [earlier, ...rows];
        const expectedChangedRanks = resolveScopedUsageContributions(changedRanks);
        const observed = observeTokens(rows);
        const warm = createUsageActivitySubjectReplay({ sourceFingerprints: new Map([...fingerprints, [earlier.id, 'new']]),
            retained: persisted(cold.entries) });
        const actual = resolveScopedUsageContributions(changedRanks, undefined, undefined, warm);
        expectSameProjection(actual, expectedChangedRanks);
        expect(projected(actual).slice(1)).toEqual(projected(expected));
        const covered = actual.totalContributions.find(value => value.id === rows[0]!.id)!;
        expect(readUsageMoney(covered.cost, 'estimatedUsd', covered.cost.estimatedUsd)).toEqual({ units: 10000000000000001n, scale: 17 });
        expect(readUsageMoney(covered.cost.breakdown!, 'input', covered.cost.breakdown!.input!)).toEqual({ units: 10000000000000001n, scale: 17 });
        expect(observed.count(), 'unchanged subjects read no source body and do no accounting fold').toBe(0);
        expect(warm.stats).toEqual({ subjectCount: 3, replayedSubjects: 1, replayedEvents: 1 });
    });

    it('replays only the changed subject and preserves backward inference replacement and earlier snapshot residuals', () => {
        const native = row('native', 'selected', 1, 10, 'turn_delta',
            { usageAccounting: { path: 'native', inferenceId: 'same' } });
        const baseline = row('baseline', 'selected', 2, 20, 'session_cumulative');
        const untouched = row('untouched', 'other', 3, 5);
        const before = [native, baseline, untouched];
        const fingerprints = new Map(before.map(value => [value.id, 'original']));
        const cold = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints });
        resolveScopedUsageContributions(before, undefined, undefined, cold);
        const runtime = row('runtime', 'selected', 86_400_001, 10, 'turn_delta',
            { usageAccounting: { path: 'runtime', inferenceId: 'same' } });
        const after = [...before, runtime];
        const expected = resolveScopedUsageContributions(after);
        const observed = observeTokens([untouched]);
        const replay = createUsageActivitySubjectReplay({ sourceFingerprints: new Map([...fingerprints, [runtime.id, 'added']]),
            retained: persisted(cold.entries) });
        const actual = resolveScopedUsageContributions(after, undefined, undefined, replay);
        expectSameProjection(actual, expected);
        expect(actual.totalContributions.find(value => value.id === 'baseline')?.tokens.total).toBe(20);
        expect(actual.totalContributions.some(value => value.id === 'native')).toBe(false);
        expect(observed.count(), 'a different subject changed; this subject restores without its source').toBe(0);
        expect(replay.stats).toEqual({ subjectCount: 2, replayedSubjects: 1, replayedEvents: 3 });
        const corrected = { ...runtime, tokens: { ...runtime.tokens, input: 12, total: 12 } };
        const correctedRows = [...before, corrected];
        const correctedExpected = resolveScopedUsageContributions(correctedRows);
        observed.reset();
        const correction = createUsageActivitySubjectReplay({ sourceFingerprints: new Map([...fingerprints, [runtime.id, 'corrected']]),
            retained: persisted(replay.entries) });
        const correctedActual = resolveScopedUsageContributions(correctedRows, undefined, undefined, correction);
        expectSameProjection(correctedActual, correctedExpected);
        expect(correctedActual.totalContributions.find(value => value.id === runtime.id)?.tokens.total).toBe(12);
        expect(observed.count()).toBe(0);
        expect(correction.stats).toEqual({ subjectCount: 2, replayedSubjects: 1, replayedEvents: 3 });
    });

    it('replays an unchanged subject when a same-instant peer changes its canonical relative order', () => {
        const ordered = (id: string, scope: string, total: number, createdAt: number, runtime: string, sequence: number) => ({
            ...row(id, 'selected', 100, total, scope, { usageAccounting: { path: 'runtime',
                runtimeEventOrder: { runtimeIncarnationId: runtime, sequence } } }), createdAt: new Date(createdAt) });
        const rows = [ordered('snapshot', 'session_cumulative', 100, 101, 'runtime-x', 2),
            ordered('delta', 'turn_delta', 10, 102, 'runtime-y', 1), row('latest', 'selected', 200, 120, 'session_cumulative')];
        const fingerprints = new Map(rows.map(value => [value.id, 'original']));
        const cold = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints });
        const before = resolveScopedUsageContributions(rows, { startMs: 175, endMs: 225 }, undefined, cold);
        const peer = { ...ordered('peer', 'turn_delta', 7, 103, 'runtime-x', 1), sessionId: 'other' };
        const after = [...rows, peer];
        const replay = createUsageActivitySubjectReplay({ sourceFingerprints: new Map([...fingerprints, [peer.id, 'added']]),
            retained: persisted(cold.entries) });
        const factPlan = replay.plan(after.map(toScopedUsageReplayFact), { startMs: 175, endMs: 225 });
        expect([...factPlan.replayContext.ranks.keys()]).toEqual(orderRuntimeObservations(after).map(value => value.id));
        expect(factPlan.subjects.map(value => value.needsReplay), 'a peer changes the earlier relative order before body hydration').toEqual([true]);
        const actual = resolveScopedUsageContributions(after, { startMs: 175, endMs: 225 }, undefined, replay);
        expectSameProjection(actual, resolveScopedUsageContributions(after, { startMs: 175, endMs: 225 }));
        expect(before.totalContributions[0]?.tokens.total).toBe(10);
        expect(actual.totalContributions[0]?.tokens.total).toBe(20);
        expect(replay.stats).toEqual({ subjectCount: 2, replayedSubjects: 2, replayedEvents: 4 });
    });

    it('drops suppressed legacy subjects and keeps exact unpriced operands through JSON persistence', () => {
        const legacy = { ...row('legacy', 'same', 1, 10), agentId: 'legacy', source: 'legacy_usage_report' };
        const measured = row('measured', 'other', 2, 5);
        measured.tokens = withUsageMoney(measured.tokens, { input: { units: 50000000000000001n, scale: 16 } });
        measured.cost = withUsageMoney({ ...measured.cost, estimatedUsd: 0.1,
            breakdown: withUsageMoney({ input: 0.1 }, { input: { units: 10000000000000001n, scale: 17 } }) },
            { estimatedUsd: { units: 10000000000000001n, scale: 17 } });
        const fingerprints = new Map([[legacy.id, 'legacy'], [measured.id, 'measured']]);
        const cold = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints });
        resolveScopedUsageContributions([legacy, measured], undefined, undefined, cold);
        const runtime = row('runtime', 'same', 3, 12);
        const replay = createUsageActivitySubjectReplay({ sourceFingerprints: new Map([...fingerprints, [runtime.id, 'added']]),
            retained: persisted(cold.entries) });
        const rows = [legacy, measured, runtime];
        const planned = replay.plan(rows.map(toScopedUsageReplayFact));
        expect([...planned.replayContext.selectedEventIds]).toEqual(['measured', 'runtime']);
        expect(planned.subjects.map(value => value.needsReplay)).toEqual([false, true]);
        const actual = resolveScopedUsageContributions(rows, undefined, undefined, replay);
        expectSameProjection(actual, resolveScopedUsageContributions(rows));
        expect(replay.entries.size).toBe(2);
        expect(replay.stats).toEqual({ subjectCount: 2, replayedSubjects: 1, replayedEvents: 1 });
        const restored = actual.totalContributions.find(value => value.id === measured.id)!;
        expect(readUsageMoney(restored.tokens, 'input', restored.tokens.input)).toEqual({ units: 50000000000000001n, scale: 16 });
        expect(readUsageMoney(restored.cost, 'estimatedUsd', restored.cost.estimatedUsd)).toEqual({ units: 10000000000000001n, scale: 17 });
        expect(readUsageMoney(restored.cost.breakdown!, 'input', restored.cost.breakdown!.input!)).toEqual({ units: 10000000000000001n, scale: 17 });
        expect(usageMoneyToNumber(readUsageMoney(restored.cost, 'estimatedUsd', restored.cost.estimatedUsd))).toBe(0.1);
    });

    it('omits source metadata and extensions while preserving the exact canonical projection', () => {
        const metadata = { usageAccounting: { path: 'runtime' }, diagnostic: 'fixture'.repeat(1024) };
        const source = { ...row('retained', 'selected', 1, 10, 'turn_delta', metadata),
            fixtureExtension: { value: 'preserved' } };
        const fingerprint = 'source'.repeat(1024);
        const fingerprints = new Map([[source.id, fingerprint]]);
        const cold = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints });
        const expected = resolveScopedUsageContributions([source], undefined, undefined, cold);
        const bytes = JSON.stringify([...cold.entries]).length;
        expect(bytes, 'fold checkpoints must not duplicate retained source metadata').toBeLessThan(metadata.diagnostic.length);
        expect([...cold.entries.values()][0]!.witness.length, 'source witness size must not grow with its retained input').toBeLessThan(fingerprint.length);
        const warm = createUsageActivitySubjectReplay({ sourceFingerprints: fingerprints, retained: persisted(cold.entries) });
        const actual = resolveScopedUsageContributions([source], undefined, undefined, warm);
        expectSameProjection(actual, expected);
        expect(actual.totalContributions[0]!.metadata).toBeUndefined();
        expect(Reflect.has(actual.totalContributions[0]!, 'fixtureExtension')).toBe(false);
        expect(warm.stats).toEqual({ subjectCount: 1, replayedSubjects: 0, replayedEvents: 0 });
    });
});
