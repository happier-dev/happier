import { UsageObservationTokensSchema, type UsageAccountingCoverageReason, type UsageAnalyticsTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { readUsageMoney, subtractUsageMoney, usageMoneyFromNumber, usageMoneyToNumber, withUsageMoney, type ExactUsageMoney } from '@happier-dev/protocol/usage/usageMoney';
import { addUsageMeasuredTokens, projectDeclaredUsageMeasuredTokens, resolveUsageMeasuredTokens, sumKnownUsageTokenParts } from '@happier-dev/protocol/usage/usageAggregation';
import { addUsageCost, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens, subtractUsageCost, subtractUsageTokens, usageHasAnyValue } from '../usageMetrics';
import type { ResolvedScopedUsageContributions, ScopedUsageContribution, ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { isScopedUsageTurnDelta, readKeyedUsageThread, readScopedUsageAccountingEvidence } from './scopedUsageEventRow';

function scopedUsageInferenceId(row: ScopedUsageEventRow): string | undefined {
    if (!isScopedUsageTurnDelta(row)) return undefined;
    const evidence = row.accountingEvidence ?? readScopedUsageAccountingEvidence(row);
    return evidence?.accounting?.inferenceId;
}

function contribution(row: ScopedUsageEventRow, tokens: UsageAnalyticsTokens = row.tokens, cost = row.cost,
    contributingEventIds: readonly string[] = [row.id]): ScopedUsageContribution {
    const { accounting } = readScopedUsageAccountingEvidence(row);
    return { ...row, tokens: tokens.measured ? tokens : projectDeclaredUsageMeasuredTokens(tokens, accounting), cost, contributingEventIds };
}

function usageMeasurementCost(cost: UsageMeasurements['cost']): UsageMeasurements['cost'] {
    if (cost.estimatedUsd === null && (cost.costSource !== 'pricing_estimate' || !cost.breakdown)) return cost;
    return { ...cost, estimatedUsd: null,
        breakdown: cost.costSource === 'pricing_estimate' ? undefined : cost.breakdown };
}

/** Derived amounts follow the admitted share of this source's own increment. */
function withAdmittedUsageEstimate(row: ScopedUsageEventRow, own: UsageMeasurements, tokens: UsageMeasurements['tokens'],
    measured: UsageMeasurements['cost'], keepTokenlessExact = false): UsageMeasurements['cost'] {
    const { estimatedUsd, breakdown, costSource } = own.cost;
    if (estimatedUsd === null && (costSource !== 'pricing_estimate' || !breakdown)) return measured;
    const accounting = row.accountingEvidence?.accounting;
    const tokenParts = (value: UsageMeasurements['tokens']) => sumKnownUsageTokenParts({
        ...value,
        ...(row.tokens.input !== null && accounting?.inputIncludesCache !== false ? { cacheRead: null, cacheWrite: null } : {}),
        ...(row.tokens.output !== null && accounting?.outputIncludesReasoning !== false ? { reasoning: null } : {}),
    });
    // Use the same basis for both operands. An explicit aggregate zero is evidence.
    const sourceTokens = own.tokens.measured?.total ?? own.tokens.total ?? tokenParts(own.tokens);
    const admittedTokens = tokens.measured?.total ?? (own.tokens.total === null ? tokenParts(tokens) : tokens.total);
    // A settled provider estimate can be the only measurement of an exact fact.
    // A measured zero token increment still allocates no derived money.
    const share = sourceTokens === null && keepTokenlessExact ? 1
        : sourceTokens && admittedTokens ? Math.min(1, admittedTokens / sourceTokens) : 0;
    if (share === 0) return measured;

    const scale = (value: number, object: object, field: string) => share === 1
        ? readUsageMoney(object, field, value)
        : usageMoneyFromNumber(value * share);
    const estimate = estimatedUsd === null ? null : scale(estimatedUsd, own.cost, 'estimatedUsd');
    const result = estimate === null ? { ...measured }
        : withUsageMoney({ ...measured, estimatedUsd: usageMoneyToNumber(estimate) }, { estimatedUsd: estimate });
    if (breakdown && costSource === 'pricing_estimate') {
        const parts = Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, scale(value, breakdown, key)]));
        result.breakdown = withUsageMoney(Object.fromEntries(Object.entries(parts)
            .map(([key, value]) => [key, usageMoneyToNumber(value)])), parts);
    }
    return result;
}

/** A missing category is no new counter reading, so retain its last measured baseline. */
function retainSnapshotMeasurements(row: ScopedUsageEventRow, previous?: ScopedUsageEventRow): ScopedUsageEventRow {
    if (!previous) return row;
    return { ...row, tokens: {
        input: row.tokens.input ?? previous.tokens.input,
        output: row.tokens.output ?? previous.tokens.output,
        reasoning: row.tokens.reasoning ?? previous.tokens.reasoning,
        cacheRead: row.tokens.cacheRead ?? previous.tokens.cacheRead,
        cacheWrite: row.tokens.cacheWrite ?? previous.tokens.cacheWrite,
        total: row.tokens.total ?? previous.tokens.total,
    }, cost: { ...row.cost,
        reportedUsd: row.cost.reportedUsd ?? previous.cost.reportedUsd,
        estimatedUsd: row.cost.estimatedUsd ?? previous.cost.estimatedUsd,
        invoiceUsd: row.cost.invoiceUsd ?? previous.cost.invoiceUsd,
        breakdown: row.cost.breakdown || previous.cost.breakdown
            ? { ...previous.cost.breakdown, ...row.cost.breakdown } : undefined,
    } };
}

function measureUsageCheckpoint(row: ScopedUsageEventRow, snapshot: ScopedUsageEventRow): UsageAnalyticsTokens {
    return projectDeclaredUsageMeasuredTokens({ ...snapshot.tokens, total: row.tokens.total }, row.accountingEvidence?.accounting);
}

type UsageDiagnostic = Readonly<{
    row: ScopedUsageEventRow;
    reasons: Set<UsageAccountingCoverageReason>;
}>;

function createUsageDiagnostics() {
    const diagnostics = new Map<string, UsageDiagnostic>();
    return {
        note(row: ScopedUsageEventRow, reason: UsageAccountingCoverageReason) {
            let diagnostic = diagnostics.get(row.id);
            if (!diagnostic) {
                diagnostic = { row, reasons: new Set() };
                diagnostics.set(row.id, diagnostic);
            }
            diagnostic.reasons.add(reason);
        },
        apply(rows: ScopedUsageContribution[], ranks: ReadonlyMap<string, number>) {
            const marked = new Set<string>();
            for (const row of rows) {
                const diagnostic = diagnostics.get(row.id);
                if (!diagnostic) continue;
                row.coverageReasons = [...diagnostic.reasons];
                marked.add(row.id);
            }
            for (const [id, { row, reasons }] of diagnostics) {
                if (marked.has(id)) continue;
                const carrier = contribution({
                    ...row, requestCount: 0, contextUsedTokens: null, contextWindowTokens: null,
                }, createEmptyUsageTokens(), createEmptyUsageCost(row.cost.currency), []);
                rows.push({ ...carrier, coverageReasons: [...reasons] });
            }
            if (rows.length > 1 && diagnostics.size > marked.size) {
                rows.sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!);
            }
        },
    };
}

type UsageDiagnostics = ReturnType<typeof createUsageDiagnostics>;

function resolveUsagePopulation(rows: ScopedUsageContribution[], diagnostics: UsageDiagnostics,
    ranks: ReadonlyMap<string, number>): ResolvedScopedUsageContributions {
    diagnostics.apply(rows, ranks);
    const coverageReasons = [...new Set(rows.flatMap(row => row.coverageReasons ?? []))];
    return { totalContributions: rows, bucketAttributions: rows, coverageReasons };
}

function differsOnKnownMeasurements(left: UsageMeasurements, right: UsageMeasurements): boolean {
    const differs = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && a !== b;
    return tokenFacets.some(facet => differs(left.tokens[facet], right.tokens[facet]))
        || (left.cost.currency === right.cost.currency && (
            costFacets.some(facet => differs(left.cost[facet], right.cost[facet]))
            || Object.entries(left.cost.breakdown ?? {}).some(([key, value]) => differs(value, right.cost.breakdown?.[key]))
        ));
}

type ExactUsageFact = {
    amount: UsageSeries;
    modelId: ScopedUsageEventRow['modelId'];
    firstObservedIndex?: number;
    nativeCompletionEnd?: number;
};

function createExactUsageReplay(diagnostics: UsageDiagnostics) {
    const observed = new Map<string, ExactUsageFact>();
    const newFact = (row: ScopedUsageEventRow): ExactUsageFact => ({
        amount: createUsageSeries(), modelId: row.modelId,
    });
    return (row: ScopedUsageEventRow) => {
        const identity = scopedUsageInferenceId(row);
        const previousFact = identity ? observed.get(identity) : undefined;
        const fact = previousFact ?? newFact(row);
        if (!previousFact) {
            if (identity) observed.set(identity, fact);
            fact.amount.add(row);
            return { identity, fact, increment: row, first: true, increased: true };
        }
        const previous = fact.amount.read(row.cost.currency);
        if (fact.modelId !== row.modelId || differsOnKnownMeasurements(row, previous)) {
            diagnostics.note(row, 'ambiguous_overlap');
        }
        const increment = admitThreadUsageIncrement(row, previous);
        const increased = retainsUncoveredMeasurement(increment, previous) || (increment.tokens.measured?.total ?? 0) > 0;
        if (increased) fact.amount.add(increment);
        return { identity, fact, increment, first: false, increased };
    };
}

function emptyUsageMeasurements(currency?: string): UsageMeasurements {
    return { tokens: createEmptyUsageTokens(), cost: createEmptyUsageCost(currency) };
}

function addUsageMeasurements(left: UsageMeasurements, right: UsageMeasurements): UsageMeasurements {
    return { tokens: addUsageMeasuredTokens(left.tokens, right.tokens), cost: addUsageCost(left.cost, right.cost) };
}

/** Checkpoints settle the token and derived-money increments of their own source. */
function createSameSourceUsageIncrements() {
    type Source = {
        previous?: ThreadUsageObservation;
        pending: UsageMeasurements;
        interval: UsageMeasurements;
        exact: Map<string, UsageSeries>;
    };
    const sources = new Map<string | null, Source>();
    function source(row: ScopedUsageEventRow): Source {
        const path = row.accountingEvidence?.accounting?.path ?? row.source;
        const existing = sources.get(path);
        if (existing) return existing;
        const empty = emptyUsageMeasurements(row.cost.currency);
        const state = { pending: empty, interval: empty, exact: new Map<string, UsageSeries>() };
        sources.set(path, state);
        return state;
    }
    return {
        exact(row: ScopedUsageEventRow, measured: UsageMeasurements, identity: string | undefined, trackMeasured: boolean) {
            const state = source(row);
            let increment = measured;
            const first = !identity || !state.exact.has(identity);
            if (identity) {
                const exact = state.exact.get(identity) ?? createUsageSeries();
                increment = admitThreadUsageIncrement(measured, exact.read(row.cost.currency));
                exact.add(increment);
                state.exact.set(identity, exact);
            }
            const cost = withAdmittedUsageEstimate(row, { ...row, tokens: measured.tokens },
                trackMeasured ? increment.tokens : rawUsageTokens(increment.tokens), emptyUsageMeasurements(row.cost.currency).cost, first);
            state.interval = addUsageMeasurements(state.interval, { tokens: increment.tokens, cost });
            return increment;
        },
        checkpoint(row: ThreadUsageObservation, snapshot: ThreadUsageObservation, reset: boolean, trackMeasured: boolean) {
            const state = source(row);
            const empty = emptyUsageMeasurements(row.cost.currency);
            const previous = reset ? undefined : state.previous;
            const baseline = previous ?? empty;
            const costBaseline = baseline.cost.currency === row.cost.currency ? baseline.cost : empty.cost;
            const pending = reset ? state.interval : addUsageMeasurements(state.pending, state.interval);
            const pendingCost = pending.cost.currency === row.cost.currency ? pending.cost : empty.cost;
            const rawIncrease = subtractUsageTokens(subtractUsageTokens(row.tokens, baseline.tokens), pending.tokens);
            const increment = {
                tokens: trackMeasured ? withThreadTokenIncrease(rawIncrease, row.tokens,
                    addUsageMeasuredTokens(baseline.tokens, pending.tokens)) : rawIncrease,
                cost: subtractUsageCost(subtractUsageCost(row.cost, costBaseline), pendingCost),
            };
            const unsettled = createEmptyUsageTokens();
            for (const facet of tokenFacets) {
                if (row.tokens[facet] === null) unsettled[facet] = pending.tokens[facet];
            }
            const pendingMeasurement = resolveUsageMeasuredTokens(pending.tokens);
            const settledMeasurement = resolveUsageMeasuredTokens(row.tokens).total !== null;
            // A measured checkpoint settles the whole even when individual raw
            // parts stay pending for a later raw counter reading.
            const measured = pendingMeasurement.total === null ? undefined
                : { total: settledMeasurement ? 0 : pendingMeasurement.total, fromParts: true };
            state.pending = reset ? empty : { tokens: measured ? { ...unsettled, measured } : unsettled, cost: {
                ...empty.cost,
                estimatedUsd: row.cost.estimatedUsd === null ? pendingCost.estimatedUsd : null,
                breakdown: pendingCost.breakdown && Object.fromEntries(Object.entries(pendingCost.breakdown)
                    .filter(([key]) => !Object.hasOwn(row.cost.breakdown ?? {}, key))),
            } };
            state.interval = empty;
            state.previous = { ...retainSnapshotMeasurements(row, previous), tokens: snapshot.tokens };
            return increment;
        },
    };
}

function isUsageOccupancyOnly(row: ScopedUsageEventRow): boolean {
    return (row.contextUsedTokens != null || row.contextWindowTokens != null)
        && !usageHasAnyValue(row.tokens, row.cost);
}

/** The canonical one-shot accounting fold shared by scalar and batch reads. */
function foldRetainedUsageContributions(rows: readonly ScopedUsageEventRow[],
    ranks: Map<string, number>): ResolvedScopedUsageContributions {
    const rank = (id: string) => ranks.get(id) ?? Infinity;
    const compare = (left: ScopedUsageEventRow, right: ScopedUsageEventRow) =>
        rank(left.id) - rank(right.id) || left.id.localeCompare(right.id);
    const inferred = new Map<string, ScopedUsageEventRow>();
    let inferenceAmbiguous = false;
    const candidates: ScopedUsageEventRow[] = [];
    const replaced = new Set<string>();
    for (const input of [...rows].sort(compare)) {
        const row = input.accountingEvidence ? input
            : { ...input, accountingEvidence: readScopedUsageAccountingEvidence(input) };
        const identity = scopedUsageInferenceId(row);
        if (!identity) { candidates.push(row); continue; }
        const previous = inferred.get(identity);
        if (previous && (previous.tokens.total !== row.tokens.total || previous.modelId !== row.modelId))
            inferenceAmbiguous = true;
        const previousPath = previous?.accountingEvidence?.accounting?.path;
        const path = row.accountingEvidence?.accounting?.path;
        const previousOrder = previous?.accountingEvidence?.accounting?.runtimeEventOrder;
        const order = row.accountingEvidence?.accounting?.runtimeEventOrder;
        const sameRuntime = previousPath === 'runtime' && path === 'runtime' && previousOrder && order
            && previousOrder.runtimeIncarnationId === order.runtimeIncarnationId;
        if (!previous || previousPath !== 'runtime' || (path === 'runtime'
            && (!sameRuntime || order.sequence < previousOrder.sequence))) {
            if (previous) replaced.add(previous.id);
            inferred.set(identity, row);
            candidates.push(row);
        }
    }
    const selected = candidates.filter(row => !replaced.has(row.id));
    const latestFinal = selected.filter(row => row.scope === 'session_final').at(-1);
    const base: ScopedUsageContribution[] = [];
    let previousSnapshot: ScopedUsageEventRow | undefined;
    let previousTokenSnapshot: (ScopedUsageEventRow & { tokens: UsageAnalyticsTokens }) | undefined;
    let pendingTokenDeltas = createEmptyUsageTokens();
    let pendingCostDeltas = createEmptyUsageCost();
    let pending: ScopedUsageEventRow[] = [];
    let intervalStartIndex = 0;
    let reportedCoverageStartIndex = 0;
    const snapshotReasons = new Set<UsageAccountingCoverageReason>();
    const uncorrelatedSources = new Set<string | null>();
    for (const row of selected) {
        if (isScopedUsageTurnDelta(row)) {
            const item = contribution(row);
            base.push(item);
            pending.push(row);
            if (!row.accountingEvidence?.accounting?.inferenceId) uncorrelatedSources.add(row.source);
            continue;
        }
        const hasMeasuredTokens = row.tokens.input !== null || row.tokens.output !== null || row.tokens.reasoning !== null
            || row.tokens.cacheRead !== null || row.tokens.cacheWrite !== null || row.tokens.total !== null;
        if (!hasMeasuredTokens
            && row.cost.reportedUsd === null && row.cost.estimatedUsd === null && row.cost.invoiceUsd == null) {
            // An observation without measurements still witnesses coverage and
            // its own subject. It cannot replace a measured counter baseline.
            base.push(contribution(row));
            continue;
        }
        if ((row.contextUsedTokens != null || row.contextWindowTokens != null)
            && !usageHasAnyValue(row.tokens, row.cost)) {
            // Occupancy is a presentation fact, not an inference counter or money baseline.
            const item = contribution(row);
            base.push(item);
            continue;
        }
        if (latestFinal && compare(row, latestFinal) > 0) continue;
        const intervalTokens = pending.reduce((sum, delta) => addUsageTokens(sum, delta.tokens), createEmptyUsageTokens());
        const intervalCost = pending.reduce((sum, delta) => addUsageCost(sum, delta.cost),
            createEmptyUsageCost(row.cost.currency));
        pending = [];
        const hasTokenSnapshot = hasMeasuredTokens
            && ((row.contextUsedTokens == null && row.contextWindowTokens == null)
                || usageHasAnyValue(row.tokens, createEmptyUsageCost(row.cost.currency)));
        pendingTokenDeltas = addUsageTokens(pendingTokenDeltas, intervalTokens);
        pendingCostDeltas = addUsageCost(pendingCostDeltas, intervalCost);
        const epoch = row.accountingEvidence?.accounting?.counterEpoch;
        const previousEpoch = previousSnapshot?.accountingEvidence?.accounting?.counterEpoch;
        const witnessedReset = previousSnapshot && epoch !== undefined && previousEpoch !== undefined && epoch !== previousEpoch;
        const tokenReset = hasTokenSnapshot && previousTokenSnapshot
            && row.tokens.total !== null && previousTokenSnapshot.tokens.total !== null
            && row.tokens.total < previousTokenSnapshot.tokens.total;
        const reset = previousSnapshot && (witnessedReset || tokenReset);
        if (reset) {
            // A new epoch cannot settle deltas retained across older snapshots.
            // Keep only this interval, as with an ordinary counter reset.
            pendingTokenDeltas = intervalTokens;
            pendingCostDeltas = intervalCost;
        }
        if (reset) reportedCoverageStartIndex = intervalStartIndex;
        if (reset && !witnessedReset) snapshotReasons.add('counter_discontinuity');
        const baselineTokens: UsageAnalyticsTokens = previousTokenSnapshot && !reset ? previousTokenSnapshot.tokens : createEmptyUsageTokens();
        const baselineCost = previousSnapshot && !reset ? previousSnapshot.cost : createEmptyUsageCost(row.cost.currency);
        const missingBaseline = hasTokenSnapshot && !previousTokenSnapshot
            && row.tokens.total !== null
            && (pendingTokenDeltas.total === null ? row.tokens.total > 0 : row.tokens.total > pendingTokenDeltas.total)
            && row.accountingEvidence?.accounting?.historyComplete !== true;
        const increaseTokens = subtractUsageTokens(row.tokens, baselineTokens);
        if (hasTokenSnapshot && increaseTokens.total !== null && pendingTokenDeltas.total !== null
            && increaseTokens.total < pendingTokenDeltas.total) snapshotReasons.add('ambiguous_overlap');
        let nextTokenSnapshot: (ScopedUsageEventRow & { tokens: UsageAnalyticsTokens }) | undefined =
            hasTokenSnapshot ? retainSnapshotMeasurements(row, reset ? undefined : previousTokenSnapshot) : undefined;
        let tokens: UsageAnalyticsTokens = hasTokenSnapshot ? subtractUsageTokens(increaseTokens, pendingTokenDeltas) : row.tokens;
        const accounting = row.accountingEvidence?.accounting;
        if (nextTokenSnapshot && (accounting?.inputIncludesCache === true || accounting?.outputIncludesReasoning === true)) {
            // A sparse checkpoint can expose new detail about tokens already present in its whole.
            // Measure retained levels first and preserve the raw delta as separate evidence.
            const level = measureUsageCheckpoint(row, nextTokenSnapshot);
            if (level.measured || baselineTokens.measured) {
                const coveredTurnTokens = subtractUsageTokens(increaseTokens, tokens);
                const covered = resolveUsageMeasuredTokens(projectDeclaredUsageMeasuredTokens(coveredTurnTokens, accounting));
                const previousLevel = resolveUsageMeasuredTokens(baselineTokens).total;
                const currentLevel = resolveUsageMeasuredTokens(level).total ?? 0;
                tokens = { ...tokens, measured: {
                    total: subtractMeasuredUsageLevel(currentLevel, previousLevel, covered.total), fromParts: true,
                } };
            }
            if (level.measured) nextTokenSnapshot = { ...nextTokenSnapshot, tokens: { ...nextTokenSnapshot.tokens, measured: level.measured } };
        }
        const cost = subtractUsageCost(subtractUsageCost(row.cost, baselineCost), pendingCostDeltas);
        const hasReportedTotal = (row.cost.reportedUsd !== null && row.cost.reportedUsd > 0) || row.cost.costSource === 'provider_reported'
            || row.cost.costSource === 'provider_reported_api_equivalent';
        const coveredIds: string[] = [];
        const hasMeasuredIncrease = (tokens.measured?.total ?? 0) > 0;
        const hasResidual = hasMeasuredIncrease || usageHasAnyValue(tokens, { ...cost, reportedUsd: 0, invoiceUsd: 0 });
        const totalId = hasResidual ? `${row.id}:reported` : row.id;
        ranks.set(totalId, rank(row.id));
        if (hasReportedTotal) {
            for (let index = reportedCoverageStartIndex; index < base.length; index++) {
                const item = base[index]!;
                const reported = (item.cost.reportedUsd !== null && item.cost.reportedUsd > 0) || item.cost.costSource === 'provider_reported'
                    || item.cost.costSource === 'provider_reported_api_equivalent';
                if (!reported && item.cost.currency === row.cost.currency) {
                    coveredIds.push(item.id);
                    base[index] = { ...item, cost: { ...item.cost, reportedTotalId: totalId } };
                }
            }
        }
        const coverageReasons: UsageAccountingCoverageReason[] = missingBaseline ? ['missing_baseline'] : [];
        // Only a complete cumulative population can witness its model. Partial
        // counters and final summaries may carry merely the current/last model.
        const residualModelId = row.scope === 'session_cumulative'
            && row.accountingEvidence?.accounting?.historyComplete === true ? row.modelId : null;
        if (coveredIds.length > 0) {
            if (hasResidual) {
                coveredIds.push(row.id);
                const residual = contribution({ ...row, modelId: residualModelId, turnId: null }, tokens,
                    { ...cost, reportedUsd: 0, invoiceUsd: 0,
                        costSource: cost.estimatedUsd !== null && cost.estimatedUsd > 0 ? 'pricing_estimate' : 'none', reportedTotalId: totalId });
                const item = { ...residual, coverageReasons };
                base.push(item);
            }
            const total = contribution({ ...row, id: totalId, modelId: null, turnId: null }, createEmptyUsageTokens(),
                { ...cost, estimatedUsd: 0, reportedTotalContributionIds: coveredIds }, hasResidual ? [] : [row.id]);
            const item = { ...total, coverageReasons };
            base.push(item);
        } else if (hasMeasuredIncrease || usageHasAnyValue(tokens, cost)
            || tokens.input !== null && previousTokenSnapshot?.tokens.input == null
            || tokens.output !== null && previousTokenSnapshot?.tokens.output == null
            || tokens.reasoning !== null && previousTokenSnapshot?.tokens.reasoning == null
            || tokens.cacheRead !== null && previousTokenSnapshot?.tokens.cacheRead == null
            || tokens.cacheWrite !== null && previousTokenSnapshot?.tokens.cacheWrite == null
            || tokens.total !== null && previousTokenSnapshot?.tokens.total == null
            || cost.reportedUsd !== null && previousSnapshot?.cost.reportedUsd == null
            || cost.estimatedUsd !== null && previousSnapshot?.cost.estimatedUsd == null
            || cost.invoiceUsd != null && previousSnapshot?.cost.invoiceUsd == null) {
            const residual = contribution({ ...row, modelId: residualModelId, turnId: null }, tokens, cost);
            const item = { ...residual, coverageReasons };
            base.push(item);
        }
        if (hasReportedTotal) reportedCoverageStartIndex = base.length;
        if (hasTokenSnapshot || witnessedReset) {
            previousTokenSnapshot = nextTokenSnapshot;
            // Only a measured counter settles its pending deltas. Sparse
            // snapshots leave the other category baselines unchanged.
            pendingTokenDeltas = reset ? createEmptyUsageTokens() : {
                input: row.tokens.input === null ? pendingTokenDeltas.input : null,
                output: row.tokens.output === null ? pendingTokenDeltas.output : null,
                reasoning: row.tokens.reasoning === null ? pendingTokenDeltas.reasoning : null,
                cacheRead: row.tokens.cacheRead === null ? pendingTokenDeltas.cacheRead : null,
                cacheWrite: row.tokens.cacheWrite === null ? pendingTokenDeltas.cacheWrite : null,
                total: row.tokens.total === null ? pendingTokenDeltas.total : null,
            };
        }
        pendingCostDeltas = reset ? createEmptyUsageCost(row.cost.currency) : { ...pendingCostDeltas,
            reportedUsd: row.cost.reportedUsd === null ? pendingCostDeltas.reportedUsd : null,
            estimatedUsd: row.cost.estimatedUsd === null ? pendingCostDeltas.estimatedUsd : null,
            invoiceUsd: row.cost.invoiceUsd == null ? pendingCostDeltas.invoiceUsd : null,
            breakdown: pendingCostDeltas.breakdown ? Object.fromEntries(Object.entries(pendingCostDeltas.breakdown)
                .filter(([key]) => !Object.hasOwn(row.cost.breakdown ?? {}, key))) : undefined,
        };
        previousSnapshot = retainSnapshotMeasurements(row, reset ? undefined : previousSnapshot);
        intervalStartIndex = base.length;
    }
    const globalReasons = new Set<UsageAccountingCoverageReason>();
    if (inferenceAmbiguous) globalReasons.add('ambiguous_overlap');
    for (const reason of snapshotReasons) globalReasons.add(reason);
    if (uncorrelatedSources.size > 1) globalReasons.add('ambiguous_overlap');
    // Every base entry was created by this fold in the already-ranked input
    // order, including adjacent residual/report entries with the same rank.
    // Attach reasons to those owned entries; only the merged population needs
    // an output sort, not each identical output shape of every subject.
    for (const row of base) row.coverageReasons = [...new Set([...globalReasons, ...row.coverageReasons ?? []])];
    const coverageReasons = [...new Set(base.flatMap(row => row.coverageReasons ?? []))];
    return { totalContributions: base, bucketAttributions: base, coverageReasons };
}

const tokenFacets = Object.keys(UsageObservationTokensSchema.shape) as (keyof ScopedUsageEventRow['tokens'])[];
const costFacets = ['reportedUsd', 'invoiceUsd'] as const;

type UsageMeasurements = Pick<ScopedUsageContribution, 'tokens' | 'cost'>;
type ThreadUsageObservation = ScopedUsageEventRow & Pick<UsageMeasurements, 'tokens'>;

function rawUsageTokens({ measured: _measured, ...raw }: UsageAnalyticsTokens) {
    return raw;
}

function uncoveredIncrement(delta: number | null | undefined, own: number | null | undefined,
    other: number | null | undefined): number | null {
    if (delta == null) return null;
    return Math.max(0, delta - Math.max(0, (other ?? 0) - (own ?? 0)));
}

function uncoveredCostMeasurements<T extends object, Key extends keyof T & string>(
    current: T, own: T | undefined, other: T | undefined, fields: readonly Key[],
): T {
    const result = { ...current };
    const exact: Record<string, ExactUsageMoney> = {};
    const zero = usageMoneyFromNumber(0);
    for (const field of fields) {
        const value = current[field];
        if (typeof value !== 'number') continue;
        const previous = other?.[field];
        const local = own?.[field];
        const debt = subtractUsageMoney(
            typeof previous === 'number' ? readUsageMoney(other!, field, previous) : zero,
            typeof local === 'number' ? readUsageMoney(own!, field, local) : zero);
        const difference = subtractUsageMoney(readUsageMoney(current, field, value), debt.units > 0n ? debt : zero);
        exact[field] = difference.units > 0n ? difference : zero;
        Reflect.set(result, field, usageMoneyToNumber(exact[field]));
    }
    return withUsageMoney(result, exact);
}

/** The emitting side increases max(own, other) only after catching up to the other side. */
function admitUsageSeriesIncrement<T extends UsageMeasurements>(row: T, own: UsageMeasurements, other: UsageMeasurements): T {
    const tokens = createEmptyUsageTokens();
    for (const facet of tokenFacets) {
        tokens[facet] = uncoveredIncrement(row.tokens[facet], own.tokens[facet], other.tokens[facet]);
    }
    const cost = uncoveredCostMeasurements(row.cost, own.cost, other.cost, costFacets);
    if (row.cost.breakdown) {
        cost.breakdown = uncoveredCostMeasurements(row.cost.breakdown, own.cost.breakdown, other.cost.breakdown,
            Object.keys(row.cost.breakdown));
    }
    return { ...row, tokens, cost };
}

function subtractMeasuredUsageLevel(current: number, baseline: number | null, covered: number | null): number {
    return Math.max(0, current - (baseline ?? 0) - (covered ?? 0));
}

/** Keep raw counter detail separate from the increment of the measured level. */
function withThreadTokenIncrease(raw: UsageAnalyticsTokens, current: UsageAnalyticsTokens,
    coveredTokens: UsageAnalyticsTokens): UsageAnalyticsTokens {
    const level = resolveUsageMeasuredTokens(current);
    if (level.total === null) return raw;
    const covered = resolveUsageMeasuredTokens(coveredTokens);
    const total = subtractMeasuredUsageLevel(level.total, null, covered.total);
    return { ...raw, measured: { total, fromParts: level.fromParts || covered.fromParts } };
}

function admitThreadUsageIncrement(row: UsageMeasurements, covered: UsageMeasurements): UsageMeasurements {
    const contribution = admitUsageSeriesIncrement(row, emptyUsageMeasurements(row.cost.currency), covered);
    return { ...contribution, tokens: withThreadTokenIncrease(contribution.tokens, row.tokens, covered.tokens) };
}

function retainsUncoveredMeasurement(row: UsageMeasurements, covered: UsageMeasurements): boolean {
    const uncovered = (value: number | null | undefined, previous: number | null | undefined) =>
        value != null && (value > 0 || previous == null);
    return tokenFacets.some(facet => uncovered(row.tokens[facet], covered.tokens[facet]))
        || costFacets.some(facet => uncovered(row.cost[facet], covered.cost[facet]))
        || Object.entries(row.cost.breakdown ?? {}).some(([key, value]) => uncovered(value, covered.cost.breakdown?.[key]));
}

type UsageSeriesView = {
    read(currency: string): UsageMeasurements;
    currencies(): Iterable<string>;
};

function createUsageSeries() {
    let tokens: UsageAnalyticsTokens = createEmptyUsageTokens();
    const costs = new Map<string, ScopedUsageEventRow['cost']>();
    const read = (currency: string) => ({ tokens, cost: costs.get(currency) ?? createEmptyUsageCost(currency) });
    const add = (row: UsageMeasurements) => {
        tokens = addUsageMeasuredTokens(tokens, row.tokens);
        const { currency } = row.cost;
        costs.set(currency, addUsageCost(read(currency).cost, row.cost));
    };
    const includeMaximum = (row: UsageMeasurements) => {
        const { currency } = row.cost;
        add(admitThreadUsageIncrement(row, read(currency)));
    };
    return {
        read,
        add,
        addSeries(other: UsageSeriesView) {
            let first = true;
            for (const currency of other.currencies()) {
                const value = other.read(currency);
                add(first ? value : { ...value, tokens: createEmptyUsageTokens() });
                first = false;
            }
        },
        includeMaximum,
        includeSeriesMaximum(other: UsageSeriesView) {
            // Token facets share a stream. Cost facets retain their currency.
            for (const currency of other.currencies()) includeMaximum(other.read(currency));
        },
        currencies: () => costs.keys(),
    };
}

type UsageSeries = ReturnType<typeof createUsageSeries>;

type CheckpointBounds = {
    maximum: UsageSeries;
    pending?: UsageSeries;
    left?: CheckpointBounds;
    right?: CheckpointBounds;
};

/**
 * A source's checkpoint bounds store levels plus exact facts proved outside
 * them. Lazy range increments preserve earlier and later proof on a replay
 * without walking historical checkpoints for each response.
 */
function createCheckpointBounds(rows: readonly ScopedUsageEventRow[]) {
    let root: CheckpointBounds | undefined;
    const node = (): CheckpointBounds => ({ maximum: createUsageSeries() });
    const advance = (bounds: CheckpointBounds, credit: UsageSeries) => {
        bounds.maximum.addSeries(credit);
        (bounds.pending ??= createUsageSeries()).addSeries(credit);
    };
    const pull = (bounds: CheckpointBounds) => {
        bounds.maximum = createUsageSeries();
        if (bounds.left) bounds.maximum.includeSeriesMaximum(bounds.left.maximum);
        if (bounds.right) bounds.maximum.includeSeriesMaximum(bounds.right.maximum);
    };
    const push = (bounds: CheckpointBounds) => {
        if (!bounds.pending) return;
        if (bounds.left) advance(bounds.left, bounds.pending);
        if (bounds.right) advance(bounds.right, bounds.pending);
        bounds.pending = undefined;
    };
    function record(bounds: CheckpointBounds, start: number, end: number, index: number, level: UsageMeasurements) {
        if (end - start === 1) {
            bounds.maximum.includeMaximum(level);
            return;
        }
        // Apply prior credits only to checkpoints that already existed.
        push(bounds);
        const mid = start + Math.floor((end - start) / 2);
        if (index < mid) record(bounds.left ??= node(), start, mid, index, level);
        else record(bounds.right ??= node(), mid, end, index, level);
        pull(bounds);
    }
    function creditRange(bounds: CheckpointBounds, start: number, end: number,
        from: number, through: number, value: UsageSeries) {
        if (end <= from || start >= through) return;
        if (start >= from && end <= through) {
            advance(bounds, value);
            return;
        }
        push(bounds);
        const mid = start + Math.floor((end - start) / 2);
        if (bounds.left) creditRange(bounds.left, start, mid, from, through, value);
        if (bounds.right) creditRange(bounds.right, mid, end, from, through, value);
        pull(bounds);
    }
    return {
        record(index: number, level: UsageMeasurements) {
            record(root ??= node(), 0, rows.length, index, level);
        },
        credit(from: number, through: number, credit: UsageSeries) {
            if (root && from < through) creditRange(root, 0, rows.length, from, through, credit);
        },
        get maximum() { return root?.maximum; },
    };
}

type ThreadUsageSource = 'native' | 'runtime';

function threadUsageSource(row: ScopedUsageEventRow): ThreadUsageSource {
    return (row.accountingEvidence ?? readScopedUsageAccountingEvidence(row)).accounting?.path === 'native' ? 'native' : 'runtime';
}

/** Retain the invocation cost and scope. The thread fold decides all token increments. */
function prepareThreadReportedTotals(ordered: readonly ScopedUsageEventRow[], ranks: Map<string, number>) {
    const totals = new Map<string, ScopedUsageContribution>();
    const finals = ordered.filter(row => row.scope === 'session_final' && row.cost.reportedUsd !== null);
    if (finals.length === 0) return totals;
    const { totalContributions } = foldRetainedUsageContributions(ordered, ranks);
    const contributions = new Map(totalContributions.map(row => [row.id, row]));
    for (const { id } of finals) {
        const total = contributions.get(`${id}:reported`) ?? contributions.get(id);
        if (total?.cost.reportedTotalContributionIds) totals.set(id, total);
    }
    return totals;
}

/** Reuse the retained links, substituting the admitted presentation of a reconciled response. */
function connectThreadReportedTotals(rows: ScopedUsageContribution[], raw: readonly ScopedUsageEventRow[],
    totals: ReturnType<typeof prepareThreadReportedTotals>, ranks: ReadonlyMap<string, number>) {
    if (totals.size === 0) return;
    const byId = new Map(rows.filter(row => !row.cost.reportedTotalContributionIds).map(row => [row.id, row]));
    const byResponse = new Map<string, ScopedUsageContribution[]>();
    for (const row of rows) {
        const key = scopedUsageInferenceId(row);
        if (!key) continue;
        const presentations = byResponse.get(key);
        if (presentations) presentations.push(row);
        else byResponse.set(key, [row]);
    }
    const original = new Map(raw.map(row => [row.id, row]));
    for (const [id, total] of totals) {
        const coveredIds = new Set<string>();
        for (const coveredId of total.cost.reportedTotalContributionIds!) {
            // This is the retained fold's residual. Link the actual increment below.
            if (coveredId === id) continue;
            const source = original.get(coveredId);
            const key = source && scopedUsageInferenceId(source);
            const own = byId.get(coveredId);
            const admitted = key ? (byResponse.get(key) ?? []).filter(row => ranks.get(row.id)! <= ranks.get(coveredId)!)
                : own ? [own] : [];
            if (!admitted.length) coveredIds.add(coveredId);
            for (const row of admitted) {
                row.cost = { ...row.cost, reportedTotalId: total.id };
                coveredIds.add(row.id);
            }
        }
        const increment = byId.get(id);
        if (increment) {
            increment.cost = { ...increment.cost, reportedTotalId: total.id };
            coveredIds.add(id);
        }
        total.cost = { ...total.cost, reportedTotalContributionIds: [...coveredIds] };
    }
}

function checkpointsBefore(rows: readonly ScopedUsageEventRow[], completedAt: number) {
    let start = 0;
    let end = rows.length;
    while (start < end) {
        const mid = start + Math.floor((end - start) / 2);
        if (rows[mid]!.observedAt.getTime() < completedAt) start = mid + 1;
        else end = mid;
    }
    return start;
}

type UsageCounter = {
    last?: ThreadUsageObservation;
    epochBase: UsageSeries;
    level: UsageSeries;
    exact: UsageSeries;
};

function normalizeThreadCheckpoint(row: ThreadUsageObservation, counter: UsageCounter, firstCheckpointFloor: UsageMeasurements | undefined,
    diagnostics: UsageDiagnostics) {
    const epoch = row.accountingEvidence?.accounting?.counterEpoch;
    const previousEpoch = counter.last?.accountingEvidence?.accounting?.counterEpoch;
    const witnessedReset = epoch !== undefined && previousEpoch !== undefined && epoch !== previousEpoch;
    const retained = retainSnapshotMeasurements(row, witnessedReset ? undefined : counter.last);
    const retainedLevel = measureUsageCheckpoint(row, retained);
    const previousTotal = counter.last?.tokens.measured?.total ?? counter.last?.tokens.total;
    const nextTotal = retainedLevel.measured?.total ?? row.tokens.total;
    const decreased = nextTotal !== null && previousTotal != null && nextTotal < previousTotal;
    const reset = witnessedReset || decreased;
    const snapshot = reset ? row : retained;
    const measured = (reset ? measureUsageCheckpoint(row, row) : retainedLevel).measured;
    const checkpoint = measured ? { ...row, tokens: { ...row.tokens, measured } } : row;
    if (reset) {
        counter.epochBase = counter.level;
        counter.level = createUsageSeries();
        if (!witnessedReset) diagnostics.note(row, 'counter_discontinuity');
    }
    const level = addUsageMeasurements(counter.epochBase.read(row.cost.currency), checkpoint);
    const exactTokens = counter.exact.read(row.cost.currency).tokens;
    const exact = measured ? resolveUsageMeasuredTokens(exactTokens).total : exactTokens.total;
    const increase = measured ? resolveUsageMeasuredTokens(level.tokens).total
        : row.tokens.total === null ? null : level.tokens.total;
    // An absolute counter below its source's own exact lower bound disagrees
    // with measured facts.
    if (increase !== null && exact !== null && increase < exact) diagnostics.note(row, 'ambiguous_overlap');
    if (firstCheckpointFloor && row.accountingEvidence?.accounting?.historyComplete !== true) {
        const excess = admitThreadUsageIncrement(checkpoint, firstCheckpointFloor);
        const reportedBreakdown = row.cost.costSource === 'provider_reported'
            || row.cost.costSource === 'provider_reported_api_equivalent' || row.cost.costSource === 'invoice';
        if (usageHasAnyValue(excess.tokens, excess.cost) || measured && (excess.tokens.measured?.total ?? 0) > 0
            || (reportedBreakdown && Object.values(excess.cost.breakdown ?? {}).some(amount => amount > 0))) {
            diagnostics.note(row, 'missing_baseline');
        }
    }
    counter.last = measured ? { ...snapshot, tokens: { ...snapshot.tokens, measured } } : snapshot;
    counter.level.includeMaximum(level);
    return { checkpoint, level, snapshot: counter.last, reset };
}

function foldNativeThread(rows: readonly ScopedUsageEventRow[], ranks: Map<string, number>,
    diagnostics: UsageDiagnostics, reconciledEvidenceIds: Set<string>): ScopedUsageContribution[] {
    const ordered = [...rows].sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)!);
    const reportedTotals = prepareThreadReportedTotals(ordered, ranks);
    const checkpoints = new Map<ThreadUsageSource, ReturnType<typeof createCheckpointBounds>>([
        ['native', createCheckpointBounds(ordered)],
        ['runtime', createCheckpointBounds(ordered)],
    ]);
    const exactFloor = createUsageSeries();
    const admitted = createUsageSeries();
    const replayExact = createExactUsageReplay(diagnostics);
    const counters = new Map<ThreadUsageSource, UsageCounter>();
    const sourceIncrements = createSameSourceUsageIncrements();
    const result: ScopedUsageContribution[] = [];
    let trackMeasured = false;
    for (const [index, observed] of ordered.entries()) {
        const scoped = reportedTotals.get(observed.id);
        const cost = scoped
            ? { ...createEmptyUsageCost(observed.cost.currency), billingContext: observed.cost.billingContext }
            : usageMeasurementCost(observed.cost);
        const isExact = isScopedUsageTurnDelta(observed);
        const tokens: UsageAnalyticsTokens = isExact
            ? projectDeclaredUsageMeasuredTokens(observed.tokens, observed.accountingEvidence?.accounting) : observed.tokens;
        const row = { ...observed, tokens, cost };
        const path = threadUsageSource(row);
        let counter = counters.get(path);
        if (!counter) {
            counter = { epochBase: createUsageSeries(), level: createUsageSeries(),
                exact: createUsageSeries() };
            counters.set(path, counter);
        }
        const currency = row.cost.currency;
        const empty = emptyUsageMeasurements(currency);
        let keepDetail = false;
        let ownIncrement: UsageMeasurements = observed;
        if (isExact) {
            trackMeasured ||= tokens.measured !== undefined;
            ownIncrement = { ...observed, tokens };
            const { identity, fact, increment, increased, first } = replayExact(row);
            if (increased) exactFloor.add(increment);
            const previousCompletion = fact.nativeCompletionEnd;
            if (first) fact.firstObservedIndex = index;
            if (path === 'native') {
                fact.nativeCompletionEnd ??= checkpointsBefore(ordered, row.observedAt.getTime());
            }
            if (increased || previousCompletion !== fact.nativeCompletionEnd) {
                const firstIndex = fact.firstObservedIndex!;
                const originalSource = threadUsageSource(ordered[firstIndex]!);
                const credit = createUsageSeries();
                if (increased) credit.add(increment);
                for (const [source, bounds] of checkpoints) {
                    // Only the first presentation establishes source order for
                    // this fact. A replay can raise the amount or supply native time.
                    const sameSource = source === originalSource ? firstIndex : 0;
                    const before = first ? 0 : Math.max(sameSource, previousCompletion ?? 0);
                    const after = Math.max(sameSource, fact.nativeCompletionEnd ?? 0);
                    if (increased) bounds.credit(0, before, credit);
                    bounds.credit(before, after, fact.amount);
                }
            }
            counter.exact.add(sourceIncrements.exact(observed, row, identity, trackMeasured));
            keepDetail = first;
        } else if (!isUsageOccupancyOnly(row) && retainsUncoveredMeasurement(row, empty)) {
            const hasCheckpoint = [...checkpoints.values()].some(bounds => bounds.maximum);
            const firstCheckpointFloor = hasCheckpoint ? undefined : exactFloor.read(currency);
            const normalized = normalizeThreadCheckpoint(row, counter, firstCheckpointFloor, diagnostics);
            trackMeasured ||= normalized.checkpoint.tokens.measured !== undefined;
            ownIncrement = sourceIncrements.checkpoint({ ...observed, tokens: normalized.checkpoint.tokens },
                normalized.snapshot, normalized.reset, trackMeasured);
            checkpoints.get(path)!.record(index, normalized.level);
        } else if (!scoped) {
            // Context occupancy and measurement-free coverage do not contribute to L.
            result.push(contribution(row));
            continue;
        }

        const maximum = createUsageSeries();
        maximum.includeSeriesMaximum(exactFloor);
        for (const bounds of checkpoints.values()) {
            if (bounds.maximum) maximum.includeSeriesMaximum(bounds.maximum);
        }
        const details = isExact ? row : {
            ...row, turnId: null,
            modelId: row.scope === 'session_cumulative' && row.accountingEvidence?.accounting?.historyComplete === true
                ? row.modelId : null,
        };
        let admittedMeasurement = false;
        const firstOutput = result.length;
        for (const outputCurrency of new Set([currency, ...maximum.currencies()])) {
            const covered = admitted.read(outputCurrency);
            const bound = maximum.read(outputCurrency);
            const primary = outputCurrency === currency;
            const increase = admitThreadUsageIncrement(primary ? bound : { ...bound, tokens: createEmptyUsageTokens() }, covered);
            const tokens = trackMeasured ? increase.tokens : rawUsageTokens(increase.tokens);
            const hasIncrease = retainsUncoveredMeasurement(increase, covered) || (tokens.measured?.total ?? 0) > 0;
            admitted.add(increase);
            admittedMeasurement ||= hasIncrease;
            if (!(hasIncrease || primary && (keepDetail || row.contextUsedTokens != null || row.contextWindowTokens != null))) continue;
            const id = primary ? row.id : `${row.id}:currency:${outputCurrency}`;
            if (!primary) ranks.set(id, ranks.get(row.id)!);
            const cost = { ...increase.cost, billingContext: row.cost.billingContext,
                costSource: increase.cost.costSource === 'none' ? row.cost.costSource : increase.cost.costSource };
            result.push(contribution({ ...details, id, requestCount: primary && (keepDetail || !isExact) ? row.requestCount : 0 },
                tokens, primary ? withAdmittedUsageEstimate(observed, ownIncrement, tokens, cost, keepDetail) : cost,
                primary && (keepDetail || hasIncrease && !isExact) ? [row.id] : []));
        }
        if (scoped) {
            const hasIncrement = result[firstOutput]?.id === row.id;
            const totalId = hasIncrement ? `${row.id}:reported` : row.id;
            ranks.set(totalId, ranks.get(row.id)!);
            const total = { ...scoped, id: totalId, coverageReasons: undefined,
                contributingEventIds: hasIncrement ? [] : [row.id] };
            reportedTotals.set(row.id, total);
            result.push(total);
        } else if (!admittedMeasurement) {
            reconciledEvidenceIds.add(row.id);
        }
    }
    connectThreadReportedTotals(result, ordered, reportedTotals, ranks);
    return result;
}

/** Released reports have a final observation time, rather than a live competing counter. */
export function foldReleasedUsageContributions(legacy: readonly ScopedUsageEventRow[],
    modernPrefix: readonly ScopedUsageContribution[], ranks: Map<string, number>): ResolvedScopedUsageContributions {
    const before = foldRetainedUsageContributions(legacy, ranks);
    if (modernPrefix.length === 0) return before;
    let modernTokens = createEmptyUsageTokens();
    const modernCosts = new Map<string, ScopedUsageEventRow['cost']>();
    for (const row of modernPrefix) {
        modernTokens = addUsageTokens(modernTokens, row.tokens);
        const { currency } = row.cost;
        modernCosts.set(currency, addUsageCost(modernCosts.get(currency) ?? createEmptyUsageCost(currency), row.cost));
    }
    let releasedTokens = createEmptyUsageTokens();
    const releasedCosts = new Map<string, ScopedUsageEventRow['cost']>();
    const totalContributions: ScopedUsageContribution[] = [];
    for (const row of before.totalContributions) {
        const { currency } = row.cost;
        const cost = releasedCosts.get(currency) ?? createEmptyUsageCost(currency);
        const covered = { tokens: modernTokens, cost: modernCosts.get(currency) ?? createEmptyUsageCost(currency) };
        const residual = admitUsageSeriesIncrement(row, { tokens: releasedTokens, cost }, covered);
        if (retainsUncoveredMeasurement(residual, covered)) {
            totalContributions.push({ ...residual, coverageReasons: ['missing_baseline'] });
        }
        releasedTokens = addUsageTokens(releasedTokens, row.tokens);
        releasedCosts.set(currency, addUsageCost(cost, row.cost));
    }
    const coverageReasons = [...new Set(totalContributions.flatMap(row => row.coverageReasons ?? []))];
    return { totalContributions, bucketAttributions: totalContributions, coverageReasons };
}

/** Choose the accounting contract only after Home's admission has scoped the rows. */
export function foldScopedUsageContributions(rows: readonly ScopedUsageEventRow[],
    ranks: Map<string, number>): ResolvedScopedUsageContributions {
    const first = rows[0] && readKeyedUsageThread(rows[0]);
    if (!first || !rows.every(row => readKeyedUsageThread(row) === first)
        || !rows.some(row => threadUsageSource(row) !== threadUsageSource(rows[0]!))) {
        return foldRetainedUsageContributions(rows, ranks);
    }
    const diagnostics = createUsageDiagnostics();
    const reconciledEvidenceIds = new Set<string>();
    const contributions = foldNativeThread(rows, ranks, diagnostics, reconciledEvidenceIds);
    const resolved = resolveUsagePopulation(contributions, diagnostics, ranks);
    return reconciledEvidenceIds.size ? { ...resolved, reconciledEvidenceIds } : resolved;
}
