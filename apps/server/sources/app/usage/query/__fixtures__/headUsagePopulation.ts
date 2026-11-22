import type { UsageAnalyticsQueryRequest as Query } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import type { UsageAnalyticsSnapshot } from '../../usageQueryService';
import type { UsageAnalyticsPopulation } from '../projectUsageAnalyticsPopulation';
import { foldScopedUsageContributions as foldHead } from './headScopedUsageContributionFold';
import { orderRuntimeObservations, usageAccountingSubjectKey } from '../resolveScopedUsageContributions';
import { isPublicEligibleUsageRow, toScopedUsageEventRow } from '../scopedUsageEventRow';
import { canMatchUsageFilters, matchesUsageFilters } from '../usageQueryFilters';
import { projectUsageAnalyticsDemands } from '../projectUsageAnalyticsDemands';
import { resolveUsageCostMode } from '../resolveUsageCostMode';

type Row = UsageAnalyticsSnapshot['rows'][number];

export function bySubject(rows: readonly ReturnType<typeof toScopedUsageEventRow>[]) {
    const groups = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
        const key = usageAccountingSubjectKey(row);
        const current = groups.get(key);
        if (current) current.push(row);
        else groups.set(key, [row]);
    }
    return groups;
}

/** HEAD's captured-row selection and contribution-only coverage, with no released reports in these fixtures. */
export function headPopulation(rows: readonly Row[], query: Query): UsageAnalyticsPopulation {
    const range = query.dateRange!;
    const history = rows.filter(row => row.observedAt.getTime() < range.endMs).map(toScopedUsageEventRow);
    const ranks = new Map(orderRuntimeObservations(history).map((row, index) => [row.id, index]));
    const publicPopulation = query.population === 'public_eligible_personal';
    const groups = [...bySubject(history).values()];
    const selected = groups.filter(group => group.some(row => row.observedAt.getTime() >= range.startMs
        && canMatchUsageFilters(row, query.filters)));
    const contributions = selected.flatMap(group => foldHead(group, ranks).totalContributions)
        .filter(row => row.observedAt.getTime() >= range.startMs)
        .sort((left, right) => ranks.get(left.id)! - ranks.get(right.id)! || left.id.localeCompare(right.id));
    const totalContributions = contributions.filter(row => (!publicPopulation || isPublicEligibleUsageRow(row))
        && matchesUsageFilters(row, query.filters));
    let evidenceRows = history;
    if (publicPopulation || query.filters?.execution !== undefined) {
        const ids = new Set(totalContributions.flatMap(row => row.contributingEventIds));
        evidenceRows = history.filter(row => ids.has(row.id) && (!publicPopulation || isPublicEligibleUsageRow(row)));
    } else {
        const subjects = new Set(totalContributions.map(usageAccountingSubjectKey));
        evidenceRows = history.filter(row => subjects.has(usageAccountingSubjectKey(row)) || matchesUsageFilters(row, query.filters));
    }
    return { totalContributions, evidenceRows, costMode: resolveUsageCostMode(query.costMode) };
}

export async function headBatchRow(snapshot: UsageAnalyticsSnapshot, catalog: UsageModelPriceCatalog, request: Query, compact: boolean) {
    const project = await projectUsageAnalyticsDemands(snapshot, [request], catalog, headPopulation(snapshot.rows, request), compact);
    const { priceCatalog: _catalog, contributions, ...facts } = await project(request, snapshot);
    return { query: request, value: compact ? facts : { ...facts, contributions } };
}
