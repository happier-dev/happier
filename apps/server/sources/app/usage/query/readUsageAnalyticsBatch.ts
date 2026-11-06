import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsQueryBatchResponse, type UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Tx } from '@/storage/inTx';
import { prepareUsageAnalyticsProjectionSteps, type UsageAnalyticsProjectionContext, type UsageAnalyticsSnapshot } from '../usageQueryService';
import { captureUsageModelPriceCatalogInTx, resolveCapturedUsageModelPriceCatalog } from '../usageModelPriceCatalog';
import { hasUsageMessageCountDemand, loadUsageMessageCountsBySessionInTx } from './loadUsageMessageStatsForQuery';
import { projectUsageAnalyticsPopulationSteps, type UsageAnalyticsPopulation } from './projectUsageAnalyticsPopulation';
import { completeUsageAnalyticsProjection, projectUsageAnalyticsDemands } from './projectUsageAnalyticsDemands';
import { projectUsageAnalyticsSummarySteps } from '@happier-dev/protocol/usage/usageCost';
import { setImmediate } from 'node:timers/promises';
import type { UsageQueryTiming } from './usageQueryTiming';
import { projectUsageCoverageEvidence } from './projectUsageCoverageEvidence';
import { loadRetainedLegacyUsageReports, loadUsageEventsForQuery } from './loadUsageEventsForQuery';
import { toScopedUsageEvidenceRow } from './scopedUsageEventRow';

const usageQuerySliceMs = 20;

/** Output flags share a population; chart coordinates share a projection of it. */
export function getUsageAnalyticsPopulationKey(query: UsageAnalyticsQueryRequest): string {
    return JSON.stringify([query.dateRange, query.population ?? 'all_personal_history', query.filters, query.costMode ?? 'auto']);
}

export function getUsageAnalyticsProjectionKey(query: UsageAnalyticsQueryRequest): string {
    return JSON.stringify([getUsageAnalyticsPopulationKey(query), query.granularity, query.timeZoneOffsetMinutes,
        // Public population facts also consume the requested activity fields.
        query.population === 'public_eligible_personal' ? getUsageAnalyticsQueryRequestKey(query) : undefined]);
}

/** Keep folded contribution facts and grouped coverage, releasing normalized history before pricing. */
function* prepareUsageBatchPopulation(snapshot: UsageAnalyticsSnapshot, query: UsageAnalyticsQueryRequest,
    timing?: UsageQueryTiming): Generator<void, UsageAnalyticsPopulation, void> {
    // Use the measured pricing slice (20ms) for committed normalization/folds
    // too. Reset at each advance so other requests' work is never our budget.
    let sliceStartedAt = 0;
    const steps = projectUsageAnalyticsPopulationSteps(snapshot, query, () => performance.now() - sliceStartedAt >= usageQuerySliceMs);
    const advance = () => {
        sliceStartedAt = performance.now();
        return timing ? timing.measure('fold', () => steps.next()) : steps.next();
    };
    let next = advance();
    while (!next.done) {
        yield;
        next = advance();
    }
    const population = next.value;
    return { ...population, coverageEvidence: projectUsageCoverageEvidence(population.evidenceRows), evidenceRows: [] };
}

/** Capture the common population once, preserving each query's exact transcript-count range. */
export async function captureUsageAnalyticsBatchInTx(tx: Tx, accountId: string, queries: readonly UsageAnalyticsQueryRequest[],
    isReaderClosed?: () => boolean) {
    if (queries.length === 0) return { snapshots: new Map<string, UsageAnalyticsSnapshot>(),
        priceCatalog: await captureUsageModelPriceCatalogInTx(tx) };
    const ends = queries.map(query => query.dateRange?.endMs);
    const endMs = ends.some(end => end === undefined) ? undefined
        : ends.reduce<number>((latest, end) => Math.max(latest, end ?? -Infinity), -Infinity);
    const range = { dateRange: endMs === undefined ? undefined : { endMs } };
    // Capture raw facts once. Normalization and subject selection cannot sit
    // between statements while an interactive snapshot holds a connection.
    const [rows, legacyReports, priceCatalog] = await Promise.all([
        loadUsageEventsForQuery(tx, accountId, range),
        loadRetainedLegacyUsageReports(tx, accountId, range),
        captureUsageModelPriceCatalogInTx(tx),
    ]);
    if (isReaderClosed?.()) throw new Error('Usage reader closed');
    // SQL captures counts by Session; the committed accounting population
    // selects which Session counts contribute to each response.
    const ranges = new Map(queries.filter(hasUsageMessageCountDemand)
        .map(query => [JSON.stringify(query.dateRange ?? {}), query]));
    const counts = new Map<string, NonNullable<UsageAnalyticsSnapshot['messageCountsBySession']>>();
    for (const [rangeKey, query] of ranges) counts.set(rangeKey,
        await loadUsageMessageCountsBySessionInTx(tx, accountId, query));
    const snapshots = new Map<string, UsageAnalyticsSnapshot>();
    for (const query of queries) {
        const messageCountsBySession = hasUsageMessageCountDemand(query)
            ? counts.get(JSON.stringify(query.dateRange ?? {})) : undefined;
        snapshots.set(getUsageAnalyticsQueryRequestKey(query), {
            rows, legacyReports,
            priceCatalog, messageCountsBySession });
    }
    return { snapshots, priceCatalog };
}

/** Admit each captured body before range fan-out, preserving the raw capture for its caller. */
async function admitUsageBatchMetadata(snapshot: Awaited<ReturnType<typeof captureUsageAnalyticsBatchInTx>>,
    queries: readonly UsageAnalyticsQueryRequest[], timing?: UsageQueryTiming) {
    const inputs = new Map<UsageAnalyticsSnapshot['rows'], string[]>();
    for (const query of queries) {
        const key = getUsageAnalyticsQueryRequestKey(query);
        const captured = snapshot.snapshots.get(key);
        if (!captured) continue;
        const keys = inputs.get(captured.rows) ?? [];
        keys.push(key);
        inputs.set(captured.rows, keys);
    }
    let sliceStartedAt = performance.now();
    for (const [rows, keys] of inputs) {
        const admitted: UsageAnalyticsSnapshot['rows'] = [];
        for (const row of rows) {
            admitted.push(toScopedUsageEvidenceRow(row));
            if (performance.now() - sliceStartedAt >= usageQuerySliceMs) {
                if (timing) timing.durations.fold += performance.now() - sliceStartedAt;
                await setImmediate();
                sliceStartedAt = performance.now();
            }
        }
        for (const key of keys) snapshot.snapshots.set(key, { ...snapshot.snapshots.get(key)!, rows: admitted });
    }
    if (timing) timing.durations.fold += performance.now() - sliceStartedAt;
}

/**
 * The incumbent accounting projector owns reconciliation, filters, prices and coverage.
 * Consume each population's captured inputs once its canonical accounting fold succeeds.
 */
export async function projectUsageAnalyticsBatch(snapshot: Awaited<ReturnType<typeof captureUsageAnalyticsBatchInTx>>,
    queries: readonly UsageAnalyticsQueryRequest[], includeContributions: boolean, prepareSummary = false,
    timing?: UsageQueryTiming): Promise<UsageAnalyticsQueryBatchResponse> {
    const startedAt = performance.now();
    await admitUsageBatchMetadata(snapshot, queries, timing);
    const priceCatalog = resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog);
    // Output flags do not change the admitted accounting population. Share its
    // normalization/reconciliation/prices only within this committed batch.
    const populations = new Map<string, UsageAnalyticsPopulation>();
    const demands = new Map<string, UsageAnalyticsQueryRequest[]>();
    const projectionContexts = new Map<string, UsageAnalyticsProjectionContext>();
    const captureKeysByPopulation = new Map<string, string[]>();
    for (const query of queries) {
        const requestKey = getUsageAnalyticsQueryRequestKey(query);
        const captured = snapshot.snapshots.get(requestKey);
        if (captured) projectionContexts.set(requestKey, { messageCountsBySession: captured.messageCountsBySession });
        const populationKey = getUsageAnalyticsPopulationKey(query);
        const captureKeys = captureKeysByPopulation.get(populationKey) ?? [];
        captureKeys.push(requestKey);
        captureKeysByPopulation.set(populationKey, captureKeys);
        const key = getUsageAnalyticsProjectionKey(query);
        const group = demands.get(key) ?? [];
        group.push(query);
        demands.set(key, group);
    }
    const projections = new Map<string, Awaited<ReturnType<typeof projectUsageAnalyticsDemands>>>();
    const results: UsageAnalyticsQueryBatchResponse['results'] = [];
    for (const query of queries) {
        try {
            const requestKey = getUsageAnalyticsQueryRequestKey(query);
            const captured = projectionContexts.get(requestKey)!;
            const key = getUsageAnalyticsPopulationKey(query);
            let population = populations.get(key);
            if (!population) {
                population = await completeUsageAnalyticsProjection(prepareUsageBatchPopulation(snapshot.snapshots.get(requestKey)!, query, timing));
                populations.set(key, population);
                // Later output demands borrow the folded population and message
                // counts; raw bodies and historical metadata are no longer inputs.
                for (const captureKey of captureKeysByPopulation.get(key)!) snapshot.snapshots.delete(captureKey);
                captureKeysByPopulation.delete(key);
                // Capture has committed. Let other requests settle their I/O
                // between these CPU phases, rather than starving open reads
                // until every population/output in the batch has completed.
                await setImmediate();
            }
            const coordinate = getUsageAnalyticsProjectionKey(query);
            const admitted = population;
            const scalar = async (demand: UsageAnalyticsQueryRequest, owned: UsageAnalyticsProjectionContext) => {
                const { value, pricingPartitions } = await completeUsageAnalyticsProjection(prepareUsageAnalyticsProjectionSteps(owned, demand, priceCatalog, admitted, timing));
                if (!prepareSummary) return value;
                const projected = await completeUsageAnalyticsProjection(projectUsageAnalyticsSummarySteps(value, demand, pricingPartitions));
                return { ...value, summary: projected.summary };
            };
            let project = projections.get(coordinate);
            if (!project) {
                const group = demands.get(coordinate)!;
                const shared = group.map(demand => projectionContexts.get(getUsageAnalyticsQueryRequestKey(demand))!)
                    .find(candidate => candidate.messageCountsBySession !== undefined) ?? captured;
                try {
                    const union = await projectUsageAnalyticsDemands(shared, group, priceCatalog, admitted, prepareSummary, timing);
                    project = async (demand, owned) => {
                        try {
                            return await union(demand, owned);
                        } catch {
                            // Summary calendars are prepared lazily. Isolate
                            // their failures at the same per-demand boundary.
                            projections.set(coordinate, scalar);
                            return scalar(demand, owned);
                        }
                    };
                } catch {
                    // Preserve the existing per-slice error contract when an
                    // optional section cannot project captured data. The same
                    // scalar owner isolates it; no reads or DB admission repeat.
                    project = scalar;
                }
                projections.set(coordinate, project);
                await setImmediate();
            }
            const value = await project(query, captured);
            const { priceCatalog: _catalog, contributions, ...facts } = value;
            results.push({ query, value: includeContributions ? { ...facts, contributions } : facts });
        } catch {
            // A projection failure belongs to this slice; the shared database
            // acquisition has already succeeded and readable siblings survive.
            results.push({ query, error: 'usage_query_failed' });
        }
        await setImmediate();
    }
    if (timing) timing.durations.project += performance.now() - startedAt - timing.durations.fold - timing.durations.price;
    return { v: 1, ...(includeContributions ? { priceCatalog } : {}), results };
}
