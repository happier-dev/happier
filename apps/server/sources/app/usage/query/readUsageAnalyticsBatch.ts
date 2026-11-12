import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsQueryBatchRequest, type UsageAnalyticsQueryBatchResponse, type UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import { prepareUsageAnalyticsProjectionSteps, type UsageAnalyticsProjectionContext, type UsageAnalyticsSnapshot } from '../usageQueryService';
import { captureUsageModelPriceCatalog, captureUsageModelPriceCatalogInTx, resolveCapturedUsageModelPriceCatalog } from '../usageModelPriceCatalog';
import { hasUsageMessageCountDemand, loadUsageMessageCountsBySessionInTx } from './loadUsageMessageStatsForQuery';
import { prepareUsageAnalyticsSnapshot, projectUsageAnalyticsPopulationSteps, type UsageAnalyticsPopulation } from './projectUsageAnalyticsPopulation';
import { completeUsageAnalyticsProjection, projectUsageAnalyticsDemands } from './projectUsageAnalyticsDemands';
import { projectUsageAnalyticsSummarySteps } from '@happier-dev/protocol/usage/usageSummary';
import { createUsagePricingReuse, repriceUsageAnalyticsResponseSteps } from '@happier-dev/protocol/usage/usageCost';
import { setImmediate } from 'node:timers/promises';
import type { UsageQueryTiming } from './usageQueryTiming';
import { projectUsageCoverageEvidence } from './projectUsageCoverageEvidence';
import { loadRetainedLegacyUsageReports, loadUsageEventEvidenceForQuery, loadUsageEventsForQuery } from './loadUsageEventsForQuery';
import { toScopedUsageEvidenceRow, type ScopedUsageEvidenceRow } from './scopedUsageEventRow';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { loadUsageAccountingRowsForQuery, type CapturedUsageAccountingRow } from './loadUsageAccountingRowsForQuery';
import { canSummarizeUsageActivity, captureUsageActivitySummaryInTx, publishUsageActivitySummary,
    projectUsageActivitySummarySteps, type CapturedUsageActivitySummary } from './usageActivitySummary';
import type { CapturedUsageModelPriceCatalog } from '../usageModelPriceCatalog';

export interface UsageAnalyticsBatchSnapshot {
    snapshots: Map<string, UsageAnalyticsSnapshot>;
    priceCatalog: CapturedUsageModelPriceCatalog;
    activitySummary?: CapturedUsageActivitySummary;
}

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
    const shouldYield = () => performance.now() - sliceStartedAt >= usageQuerySliceMs;
    const steps = projectUsageAnalyticsPopulationSteps(snapshot, query, shouldYield);
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
    return { ...population, coverageEvidence: population.coverageEvidence ?? projectUsageCoverageEvidence(population.evidenceRows), evidenceRows: [] };
}

/** Changed summaries project touched days; pricing still belongs to the canonical grouped owner. */
function* prepareUsageBatchActivity(summary: CapturedUsageActivitySummary,
    catalog: ReturnType<typeof resolveCapturedUsageModelPriceCatalog>, timing?: UsageQueryTiming) {
    let sliceStartedAt = 0;
    const shouldYield = () => performance.now() - sliceStartedAt >= usageQuerySliceMs;
    const projection = projectUsageActivitySummarySteps(summary, shouldYield, timing);
    const advanceProjection = () => {
        sliceStartedAt = performance.now();
        return projection.next();
    };
    let projected = advanceProjection();
    while (!projected.done) {
        yield;
        projected = advanceProjection();
    }
    const reuse = createUsagePricingReuse(catalog, {}, summary.query.costMode ?? 'auto', summary.pricingReuse);
    if (summary.compact && reuse.reusesPreviousPriceInputs) return projected.value;
    const pricing = repriceUsageAnalyticsResponseSteps(projected.value, catalog, {},
        summary.query.costMode ?? 'auto', summary.query, shouldYield, reuse);
    const advancePricing = () => {
        sliceStartedAt = performance.now();
        return timing ? timing.measure('price', () => pricing.next()) : pricing.next();
    };
    let priced = advancePricing();
    while (!priced.done) {
        yield;
        priced = advancePricing();
    }
    summary.updatedPricingReuse = reuse.snapshot();
    summary.stats.tariffCalculations = reuse.stats.tariffCalculations;
    summary.stats.tariffReuses = reuse.stats.tariffReuses;
    summary.stats.calendarTargetCalculations = reuse.stats.calendarTargetCalculations;
    summary.stats.calendarTargetReuses = reuse.stats.calendarTargetReuses;
    return priced.value;
}

function selectUsageActivitySummaryQuery(queries: readonly UsageAnalyticsQueryRequest[],
    deliveryDemand?: Pick<UsageAnalyticsQueryBatchRequest, 'contributionQueries' | 'sessionQueries'>) {
    const detailKeys = new Set(deliveryDemand?.contributionQueries?.map(getUsageAnalyticsQueryRequestKey));
    const sessionKeys = new Set(deliveryDemand?.sessionQueries?.map(getUsageAnalyticsQueryRequestKey));
    return deliveryDemand?.contributionQueries !== undefined ? queries.find(query => canSummarizeUsageActivity(query)
        && sessionKeys.has(getUsageAnalyticsQueryRequestKey(query)) && !detailKeys.has(getUsageAnalyticsQueryRequestKey(query))
        && queries.every(other => other === query
            || getUsageAnalyticsPopulationKey(other) !== getUsageAnalyticsPopulationKey(query))) : undefined;
}

async function captureUsageBatchMessageCountsInTx(tx: Tx, accountId: string, queries: readonly UsageAnalyticsQueryRequest[]) {
    const ranges = new Map(queries.filter(hasUsageMessageCountDemand)
        .map(query => [JSON.stringify(query.dateRange ?? {}), query]));
    const counts = new Map<string, NonNullable<UsageAnalyticsSnapshot['messageCountsBySession']>>();
    for (const [rangeKey, query] of ranges) counts.set(rangeKey,
        await loadUsageMessageCountsBySessionInTx(tx, accountId, query));
    return counts;
}

async function captureUsageBatchSupportInTx(tx: Tx, accountId: string, queries: readonly UsageAnalyticsQueryRequest[]) {
    const [priceCatalog, counts] = await Promise.all([
        captureUsageModelPriceCatalogInTx(tx), captureUsageBatchMessageCountsInTx(tx, accountId, queries),
    ]);
    return { priceCatalog, counts };
}

function assemblePostgresUsageBatch(captured: readonly CapturedUsageAccountingRow[],
    queries: readonly UsageAnalyticsQueryRequest[], support: Awaited<ReturnType<typeof captureUsageBatchSupportInTx>>,
    isReaderClosed?: () => boolean): UsageAnalyticsBatchSnapshot {
    if (isReaderClosed?.()) throw new Error('Usage reader closed');
    const rows: UsageAnalyticsSnapshot['rows'] = [];
    const rawEvidenceRows: NonNullable<UsageAnalyticsSnapshot['rawEvidenceRows']>[number][] = [];
    const legacyReports: UsageAnalyticsSnapshot['legacyReports'] = [];
    for (const row of captured) {
        if (row.captureKind === 'report') legacyReports.push({ id: row.id, sessionId: row.sessionId,
            key: row.reportKey, data: row.reportData, createdAt: row.createdAt, updatedAt: row.reportUpdatedAt });
        else {
            rawEvidenceRows.push(row);
            if (row.captureKind === 'body') rows.push(row);
        }
    }
    const snapshots = new Map<string, UsageAnalyticsSnapshot>();
    for (const query of queries) snapshots.set(getUsageAnalyticsQueryRequestKey(query), {
        rows, rawEvidenceRows, legacyReports, priceCatalog: support.priceCatalog,
        messageCountsBySession: hasUsageMessageCountDemand(query)
            ? support.counts.get(JSON.stringify(query.dateRange ?? {})) : undefined,
    });
    return { snapshots, priceCatalog: support.priceCatalog };
}

/** Accounting inputs are atomic in one PostgreSQL statement; CPU work holds no transaction. */
export async function captureUsageAnalyticsBatch(accountId: string, queries: readonly UsageAnalyticsQueryRequest[],
    isReaderClosed?: () => boolean,
    deliveryDemand?: Pick<UsageAnalyticsQueryBatchRequest, 'contributionQueries' | 'sessionQueries'>): Promise<UsageAnalyticsBatchSnapshot> {
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) !== 'postgres') {
        return inReadSnapshot(tx => captureUsageAnalyticsBatchInTx(tx, accountId, queries, isReaderClosed, deliveryDemand));
    }
    const summaryQuery = selectUsageActivitySummaryQuery(queries, deliveryDemand);
    if (summaryQuery) {
        const summaryCapture = inReadSnapshot(tx => captureUsageActivitySummaryInTx(tx, accountId, summaryQuery));
        const remaining = queries.filter(query => query !== summaryQuery);
        if (!remaining.length) {
            const activitySummary = await summaryCapture;
            return { snapshots: new Map([[getUsageAnalyticsQueryRequestKey(summaryQuery), activitySummary.snapshot]]),
                priceCatalog: activitySummary.snapshot.priceCatalog, activitySummary };
        }
        // The summary's witness snapshot never encloses another population's full accounting read.
        const [activitySummary, captured] = await Promise.all([
            summaryCapture, captureUsageAnalyticsBatch(accountId, remaining, isReaderClosed),
        ]);
        captured.snapshots.set(getUsageAnalyticsQueryRequestKey(summaryQuery), activitySummary.snapshot);
        return { ...captured, activitySummary };
    }
    const [captured, priceCatalog, counts] = await Promise.all([
        queries.length ? inReadSnapshot(tx => loadUsageAccountingRowsForQuery(tx, accountId, queries), { singleStatementRead: true }) : [],
        captureUsageModelPriceCatalog(),
        // Only publication/count demand needs a composing read snapshot.
        queries.some(hasUsageMessageCountDemand)
            ? inReadSnapshot(tx => captureUsageBatchMessageCountsInTx(tx, accountId, queries))
            : new Map<string, NonNullable<UsageAnalyticsSnapshot['messageCountsBySession']>>(),
    ]);
    return assemblePostgresUsageBatch(captured, queries, { priceCatalog, counts }, isReaderClosed);
}

/** Composing snapshot readers use the same accounting statement, without another admission path. */
export async function captureUsageAnalyticsBatchInTx(tx: Tx, accountId: string, queries: readonly UsageAnalyticsQueryRequest[],
    isReaderClosed?: () => boolean,
    deliveryDemand?: Pick<UsageAnalyticsQueryBatchRequest, 'contributionQueries' | 'sessionQueries'>): Promise<UsageAnalyticsBatchSnapshot> {
    const summaryQuery = selectUsageActivitySummaryQuery(queries, deliveryDemand);
    if (summaryQuery) {
        const activitySummary = await captureUsageActivitySummaryInTx(tx, accountId, summaryQuery);
        const remaining = queries.filter(query => query !== summaryQuery);
        const captured = remaining.length === 0 ? { snapshots: new Map<string, UsageAnalyticsSnapshot>(),
            priceCatalog: activitySummary.snapshot.priceCatalog }
            : await captureUsageAnalyticsBatchInTx(tx, accountId, remaining, isReaderClosed);
        captured.snapshots.set(getUsageAnalyticsQueryRequestKey(summaryQuery), activitySummary.snapshot);
        return { ...captured, activitySummary };
    }
    if (queries.length === 0) return { snapshots: new Map<string, UsageAnalyticsSnapshot>(),
        priceCatalog: await captureUsageModelPriceCatalogInTx(tx) };
    if (resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres') {
        const [captured, support] = await Promise.all([
            loadUsageAccountingRowsForQuery(tx, accountId, queries), captureUsageBatchSupportInTx(tx, accountId, queries),
        ]);
        return assemblePostgresUsageBatch(captured, queries, support, isReaderClosed);
    }
    const ends = queries.map(query => query.dateRange?.endMs);
    const endMs = ends.some(end => end === undefined) ? undefined
        : ends.reduce<number>((latest, end) => Math.max(latest, end ?? -Infinity), -Infinity);
    const range = { dateRange: endMs === undefined ? undefined : { endMs } };
    const allHistory = queries.some(query => query.dateRange?.startMs === undefined);
    const readEvents = async (): Promise<{ rows: UsageAnalyticsSnapshot['rows'] }
        | { evidence: Awaited<ReturnType<typeof loadUsageEventEvidenceForQuery>> }> => {
        return allHistory ? { rows: await loadUsageEventsForQuery(tx, accountId, range) }
            : { evidence: await loadUsageEventEvidenceForQuery(tx, accountId, range) };
    };
    const [events, legacyReports, support] = await Promise.all([
        readEvents(),
        loadRetainedLegacyUsageReports(tx, accountId, range),
        captureUsageBatchSupportInTx(tx, accountId, queries),
    ]);
    const { priceCatalog, counts } = support;
    if (isReaderClosed?.()) throw new Error('Usage reader closed');
    let rows: UsageAnalyticsSnapshot['rows'];
    let evidenceRows: ScopedUsageEvidenceRow[] | undefined;
    const preparedPopulations = new Map<string, UsageAnalyticsSnapshot>();
    // Subject selection feeds later reads in this snapshot. Do not yield while
    // holding its connection; the committed projection below owns cooperative work.
    if ('evidence' in events) {
        evidenceRows = [];
        for (const row of events.evidence) {
            const evidence = toScopedUsageEvidenceRow(row);
            evidenceRows.push(evidence);
        }
        const selectedEventIds = new Set<string>();
        const populations = new Map(queries.map(query => [getUsageAnalyticsPopulationKey(query), query]));
        // The existing replay owner discovers in-window subjects and selects their
        // complete histories, including native competitors without a Session id.
        for (const query of populations.values()) {
            const prepared = prepareUsageAnalyticsSnapshot({ rows: [], evidenceRows, legacyReports,
                priceCatalog, messageCountsBySession: undefined }, query);
            preparedPopulations.set(getUsageAnalyticsPopulationKey(query), prepared);
            for (const id of prepared.replayContext!.selectedEventIds) selectedEventIds.add(id);
        }
        if (isReaderClosed?.()) throw new Error('Usage reader closed');
        // Both reads share this snapshot. Identity is already decided; primary-key
        // hydration needs neither a native JSON predicate nor a new subject index.
        rows = await loadUsageEventsForQuery(tx, accountId, range, [...selectedEventIds]);
    } else rows = events.rows;
    // SQL captures counts by Session; the committed accounting population
    // selects which Session counts contribute to each response.
    // Output variants of one population share the same body array/admission.
    for (const prepared of preparedPopulations.values()) {
        prepared.rows = rows.filter(row => prepared.replayContext!.selectedEventIds.has(row.id));
    }
    const snapshots = new Map<string, UsageAnalyticsSnapshot>();
    for (const query of queries) {
        const prepared = preparedPopulations.get(getUsageAnalyticsPopulationKey(query));
        const messageCountsBySession = hasUsageMessageCountDemand(query)
            ? counts.get(JSON.stringify(query.dateRange ?? {})) : undefined;
        snapshots.set(getUsageAnalyticsQueryRequestKey(query), {
            ...(prepared ?? { evidenceRows, legacyReports }),
            rows: prepared?.rows ?? rows,
            preparedQueryKey: prepared ? getUsageAnalyticsQueryRequestKey(query) : undefined,
            priceCatalog, messageCountsBySession });
    }
    return { snapshots, priceCatalog };
}

/** Admit each captured body before range fan-out, preserving the raw capture for its caller. */
async function admitUsageBatchMetadata(snapshot: Awaited<ReturnType<typeof captureUsageAnalyticsBatchInTx>>,
    queries: readonly UsageAnalyticsQueryRequest[], timing?: UsageQueryTiming) {
    let sliceStartedAt = performance.now();
    const histories = new Map<NonNullable<UsageAnalyticsSnapshot['rawEvidenceRows']>, {
        evidenceRows: ScopedUsageEvidenceRow[]; normalizedEvidenceById: Map<string, ScopedUsageEvidenceRow>;
    }>();
    for (const captured of snapshot.snapshots.values()) {
        if (!captured.rawEvidenceRows) continue;
        let admitted = histories.get(captured.rawEvidenceRows);
        if (!admitted) {
            admitted = { evidenceRows: [], normalizedEvidenceById: new Map() };
            for (const row of captured.rawEvidenceRows) {
                const evidence = captured.normalizedEvidenceById?.get(row.id) ?? toScopedUsageEvidenceRow(row);
                admitted.evidenceRows.push(evidence);
                admitted.normalizedEvidenceById.set(evidence.id, evidence);
                if (performance.now() - sliceStartedAt >= usageQuerySliceMs) {
                    if (timing) timing.durations.fold += performance.now() - sliceStartedAt;
                    await setImmediate();
                    sliceStartedAt = performance.now();
                }
            }
            histories.set(captured.rawEvidenceRows, admitted);
        }
        Object.assign(captured, admitted, { rawEvidenceRows: undefined });
    }
    const inputs = new Map<UsageAnalyticsSnapshot['rows'], string[]>();
    for (const query of queries) {
        const key = getUsageAnalyticsQueryRequestKey(query);
        const captured = snapshot.snapshots.get(key);
        if (!captured) continue;
        const keys = inputs.get(captured.rows) ?? [];
        keys.push(key);
        inputs.set(captured.rows, keys);
    }
    for (const [rows, keys] of inputs) {
        const admitted: UsageAnalyticsSnapshot['rows'] = [];
        const evidenceById = snapshot.snapshots.get(keys[0]!)?.normalizedEvidenceById;
        for (const row of rows) {
            const evidence = evidenceById?.get(row.id);
            admitted.push(evidence ? { ...row, metadata: evidence.metadata, accountingEvidence: evidence.accountingEvidence }
                : toScopedUsageEvidenceRow(row));
            if (performance.now() - sliceStartedAt >= usageQuerySliceMs) {
                if (timing) timing.durations.fold += performance.now() - sliceStartedAt;
                await setImmediate();
                sliceStartedAt = performance.now();
            }
        }
        for (const key of keys) snapshot.snapshots.set(key, { ...snapshot.snapshots.get(key)!, rows: admitted });
    }
    if (snapshot.activitySummary) {
        const key = getUsageAnalyticsQueryRequestKey(snapshot.activitySummary.query);
        snapshot.activitySummary.snapshot = snapshot.snapshots.get(key)!;
    }
    if (timing) timing.durations.fold += performance.now() - sliceStartedAt;
}

/**
 * The incumbent accounting projector owns reconciliation, filters, prices and coverage.
 * Consume each population's captured inputs once its canonical accounting fold succeeds.
 */
export async function projectUsageAnalyticsBatch(snapshot: Awaited<ReturnType<typeof captureUsageAnalyticsBatchInTx>>,
    queries: readonly UsageAnalyticsQueryRequest[], includeContributions: boolean, prepareSummary = false,
    timing?: UsageQueryTiming,
    deliveryDemand?: Pick<UsageAnalyticsQueryBatchRequest, 'contributionQueries'>): Promise<UsageAnalyticsQueryBatchResponse> {
    const startedAt = performance.now();
    await admitUsageBatchMetadata(snapshot, queries, timing);
    const priceCatalog = resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog);
    const contributionQueries = deliveryDemand?.contributionQueries;
    const pricedDetail = contributionQueries && new Set(contributionQueries.map(getUsageAnalyticsQueryRequestKey));
    const canGroupPrices = (group: readonly UsageAnalyticsQueryRequest[]) => prepareSummary && pricedDetail !== undefined
        && !group.some(query => pricedDetail.has(getUsageAnalyticsQueryRequestKey(query)));
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
            const summary = snapshot.activitySummary;
            if (summary && getUsageAnalyticsQueryRequestKey(summary.query) === requestKey) {
                const value = await completeUsageAnalyticsProjection(prepareUsageBatchActivity(summary, priceCatalog, timing));
                await publishUsageActivitySummary(summary, value, priceCatalog);
                snapshot.snapshots.delete(requestKey);
                const { priceCatalog: _catalog, ...facts } = value;
                results.push({ query, value: facts });
                continue;
            }
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
                const { value, pricingPartitions } = await completeUsageAnalyticsProjection(prepareUsageAnalyticsProjectionSteps(owned, demand, priceCatalog, admitted, timing, canGroupPrices([demand])));
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
                    const union = await projectUsageAnalyticsDemands(shared, group, priceCatalog, admitted, prepareSummary, timing, canGroupPrices(group));
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
