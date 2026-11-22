import type { UsageAccountingCoverageReason, UsageAnalyticsTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { projectDeclaredUsageMeasuredTokens, resolveUsageMeasuredTokens } from '@happier-dev/protocol/usage/usageAggregation';
import { addUsageCost, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens, subtractUsageCost, subtractUsageTokens, usageHasAnyValue } from '../usageMetrics';
import type { ResolvedScopedUsageContributions, ScopedUsageContribution, ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { isScopedUsageTurnDelta, readScopedUsageAccountingEvidence } from './scopedUsageEventRow';

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

/** The canonical one-shot accounting fold shared by scalar and batch reads. */
export function foldScopedUsageContributions(rows: readonly ScopedUsageEventRow[],
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
            const level = projectDeclaredUsageMeasuredTokens({ ...nextTokenSnapshot.tokens, total: row.tokens.total }, accounting);
            if (level.measured || baselineTokens.measured) {
                const coveredTurnTokens = subtractUsageTokens(increaseTokens, tokens);
                const covered = resolveUsageMeasuredTokens(projectDeclaredUsageMeasuredTokens(coveredTurnTokens, accounting));
                const previousLevel = resolveUsageMeasuredTokens(baselineTokens).total ?? 0;
                const currentLevel = resolveUsageMeasuredTokens(level).total ?? 0;
                tokens = { ...tokens, measured: { total: Math.max(0, currentLevel - previousLevel - (covered.total ?? 0)), fromParts: true } };
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
