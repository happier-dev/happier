import type { UsageAccountingCoverageReason } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { addUsageCost, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens, subtractUsageCost, subtractUsageTokens, usageHasAnyValue } from '../usageMetrics';
import type { ResolvedScopedUsageContributions, ScopedUsageContribution, ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { isScopedUsageTurnDelta, readScopedUsageAccountingEvidence } from './scopedUsageEventRow';

function scopedUsageInferenceId(row: ScopedUsageEventRow): string | undefined {
    if (!isScopedUsageTurnDelta(row)) return undefined;
    const evidence = row.accountingEvidence ?? readScopedUsageAccountingEvidence(row);
    return evidence?.accounting?.inferenceId;
}

function contribution(row: ScopedUsageEventRow, tokens = row.tokens, cost = row.cost,
    contributingEventIds: readonly string[] = [row.id]): ScopedUsageContribution {
    return { ...row, tokens, cost, contributingEventIds };
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
    let previousTokenSnapshot: ScopedUsageEventRow | undefined;
    let pendingTokenDeltas = createEmptyUsageTokens();
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
        const hasTokenSnapshot = (row.contextUsedTokens == null && row.contextWindowTokens == null)
            || usageHasAnyValue(row.tokens, createEmptyUsageCost(row.cost.currency));
        pendingTokenDeltas = addUsageTokens(pendingTokenDeltas, intervalTokens);
        const epoch = row.accountingEvidence?.accounting?.counterEpoch;
        const previousEpoch = previousSnapshot?.accountingEvidence?.accounting?.counterEpoch;
        const witnessedReset = previousSnapshot && epoch !== undefined && previousEpoch !== undefined && epoch !== previousEpoch;
        const tokenReset = hasTokenSnapshot && previousTokenSnapshot
            && row.tokens.total < previousTokenSnapshot.tokens.total;
        const reset = previousSnapshot && (witnessedReset || tokenReset);
        if (reset) reportedCoverageStartIndex = intervalStartIndex;
        if (reset && !witnessedReset) snapshotReasons.add('counter_discontinuity');
        const baselineTokens = previousTokenSnapshot && !reset ? previousTokenSnapshot.tokens : createEmptyUsageTokens();
        const baselineCost = previousSnapshot && !reset ? previousSnapshot.cost : createEmptyUsageCost(row.cost.currency);
        const missingBaseline = hasTokenSnapshot && !previousTokenSnapshot && row.tokens.total > pendingTokenDeltas.total
            && row.accountingEvidence?.accounting?.historyComplete !== true;
        const increaseTokens = subtractUsageTokens(row.tokens, baselineTokens);
        if (hasTokenSnapshot && increaseTokens.total < pendingTokenDeltas.total) snapshotReasons.add('ambiguous_overlap');
        const tokens = hasTokenSnapshot ? subtractUsageTokens(increaseTokens, pendingTokenDeltas) : createEmptyUsageTokens();
        const cost = subtractUsageCost(subtractUsageCost(row.cost, baselineCost), intervalCost);
        const hasReportedTotal = row.cost.reportedUsd > 0 || row.cost.costSource === 'provider_reported'
            || row.cost.costSource === 'provider_reported_api_equivalent';
        const coveredIds: string[] = [];
        const hasResidual = usageHasAnyValue(tokens, { ...cost, reportedUsd: 0, invoiceUsd: 0 });
        const totalId = hasResidual ? `${row.id}:reported` : row.id;
        ranks.set(totalId, rank(row.id));
        if (hasReportedTotal) {
            for (let index = reportedCoverageStartIndex; index < base.length; index++) {
                const item = base[index]!;
                const reported = item.cost.reportedUsd > 0 || item.cost.costSource === 'provider_reported'
                    || item.cost.costSource === 'provider_reported_api_equivalent';
                if (!reported && item.cost.currency === row.cost.currency) {
                    coveredIds.push(item.id);
                    base[index] = { ...item, cost: { ...item.cost, reportedTotalId: totalId } };
                }
            }
        }
        const coverageReasons: UsageAccountingCoverageReason[] = missingBaseline ? ['missing_baseline'] : [];
        if (coveredIds.length > 0) {
            if (hasResidual) {
                coveredIds.push(row.id);
                const residual = contribution({ ...row, modelId: null, turnId: null }, tokens,
                    { ...cost, reportedUsd: 0, invoiceUsd: 0,
                        costSource: cost.estimatedUsd > 0 ? 'pricing_estimate' : 'none', reportedTotalId: totalId });
                const item = { ...residual, coverageReasons };
                base.push(item);
            }
            const total = contribution({ ...row, id: totalId, modelId: null, turnId: null }, createEmptyUsageTokens(),
                { ...cost, estimatedUsd: 0, reportedTotalContributionIds: coveredIds }, hasResidual ? [] : [row.id]);
            const item = { ...total, coverageReasons };
            base.push(item);
        } else if (usageHasAnyValue(tokens, cost)) {
            const residual = contribution({ ...row, modelId: null, turnId: null }, tokens, cost);
            const item = { ...residual, coverageReasons };
            base.push(item);
        }
        if (hasReportedTotal) reportedCoverageStartIndex = base.length;
        if (hasTokenSnapshot || witnessedReset) {
            previousTokenSnapshot = hasTokenSnapshot ? row : undefined;
            pendingTokenDeltas = createEmptyUsageTokens();
        }
        previousSnapshot = row;
        intervalStartIndex = base.length;
    }
    const globalReasons = new Set<UsageAccountingCoverageReason>();
    if (inferenceAmbiguous) globalReasons.add('ambiguous_overlap');
    for (const reason of snapshotReasons) globalReasons.add(reason);
    if (uncorrelatedSources.size > 1) globalReasons.add('ambiguous_overlap');
    const contributions = base.map(row => ({
        ...row, coverageReasons: [...new Set([...globalReasons, ...row.coverageReasons ?? []])],
    })).sort(compare);
    const coverageReasons = [...new Set(contributions.flatMap(row => row.coverageReasons))];
    return { totalContributions: contributions, bucketAttributions: contributions, coverageReasons };
}
