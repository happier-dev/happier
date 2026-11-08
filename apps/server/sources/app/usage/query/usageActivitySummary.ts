import { getUsageAnalyticsQueryRequestKey, type UsageAccountingCoverageReason, type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery } from '@happier-dev/protocol/usage/usageAnalyticsBatchDelivery';
import type { UsagePricingReuseCheckpoint } from '@happier-dev/protocol/usage/usageCost';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { rebaseUsageAnalyticsSummaryEnd } from '@happier-dev/protocol/usage/usageSummary';
import { mergeUsageActivityProjectionFacts, projectUsageActivityProjectionDayFacts, projectUsageActivitySubjectProjectionFacts,
    readUsageActivityProjectionOperand, type UsageActivityProjectionDayFacts, type UsageActivityProjectionOperand } from '@happier-dev/protocol/usage/usageActivityProjectionFacts';
import type { Tx } from '@/storage/inTx';
import type { UsageAnalyticsSnapshot } from '../usageQueryService';
import { captureUsageModelPriceCatalogInTx } from '../usageModelPriceCatalog';
import { toScopedUsageEventRow } from './scopedUsageEventRow';
import { createUsageActivitySubjectReplay, type UsageActivitySubjectReplayStats } from './usageActivitySubjectReplay';
import { mergeUsageCoverageEvidence } from './projectUsageCoverageEvidence';
import { mergeUsageResultCoverageFacts, projectUsageResultCoverage, projectUsageResultCoverageFacts,
    type UsageResultCoverageFacts } from './buildUsageResultProjection';
import { captureUsageActivityRoutingInTx, MissingUsageActivityRoutingChunk, usageActivityFingerprint,
    usageActivityProjectionDayKey, usageActivitySubjectKey,
    type UsageActivityRoutingCapture, type UsageActivityRoutingHead } from './usageActivitySummaryRouting';
import type { UsageQueryTiming } from './usageQueryTiming';
import { readUsageActivitySourceChanges, readUsageActivitySummaryHead, saveUsageActivitySummary,
    USAGE_ACTIVITY_SUMMARY_VERSION, type UsageActivitySourceChange } from './usageActivitySummaryStore';

interface ProjectionDay {
    facts: UsageActivityProjectionDayFacts;
    coverage: UsageResultCoverageFacts;
}

interface OrderedOperand {
    subjectKey: string;
    rankEventId: string;
    coverageReasons: readonly UsageAccountingCoverageReason[];
    operand: UsageActivityProjectionOperand;
}

interface SummaryHead extends UsageActivityRoutingHead {
    version: typeof USAGE_ACTIVITY_SUMMARY_VERSION;
    format: 'selective-day-facts';
    queryKey: string;
    query: UsageAnalyticsQueryRequest;
    sourceDigest: string;
    response: UsageAnalyticsQueryResponse;
    pricingReuse?: UsagePricingReuseCheckpoint;
    days: Array<[number, ProjectionDay]>;
}

/** Captured read-owned advance. Event admission and ingestion never consult this state. */
export interface CapturedUsageActivitySummary {
    accountId: string;
    query: UsageAnalyticsQueryRequest;
    expectedHead: string | null;
    changes: readonly UsageActivitySourceChange[];
    sourceDigest: string;
    snapshot: UsageAnalyticsSnapshot;
    compact?: UsageAnalyticsQueryResponse;
    pricingReuse?: UsagePricingReuseCheckpoint;
    updatedPricingReuse?: UsagePricingReuseCheckpoint;
    routing?: UsageActivityRoutingCapture;
    days: Map<number, ProjectionDay>;
    stats: UsageActivitySubjectReplayStats & {
        eventsRead: number;
        discoveryEventsRead: number;
        historyEventsRead: number;
        projectedRows: number;
        tariffCalculations: number;
        tariffReuses: number;
        calendarTargetCalculations: number;
        calendarTargetReuses: number;
        published?: boolean;
    };
}

/** Only this compact activity demand is materialized; other consumers retain their existing capture. */
export function canSummarizeUsageActivity(query: UsageAnalyticsQueryRequest): boolean {
    return query.includeActivity === true && query.granularity === 'day'
        && query.population !== 'public_eligible_personal'
        && Object.values(query.filters ?? {}).every(value => value === undefined || (Array.isArray(value) && value.length === 0))
        && !query.breakdowns?.length && !query.includeInsights && !query.includeLeaders
        && !query.includeMessageStats && !query.includeModelTimeline && !query.includeSeries;
}

function readHead(raw: string | null): SummaryHead | undefined {
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Reflect.get(value, 'version') !== USAGE_ACTIVITY_SUMMARY_VERSION
        || Reflect.get(value, 'format') !== 'selective-day-facts') return undefined;
    const head = value as SummaryHead;
    for (const report of head.legacyReports) {
        report.createdAt = new Date(report.createdAt);
        report.updatedAt = new Date(report.updatedAt);
    }
    return head;
}

function projectionShape(query: UsageAnalyticsQueryRequest): string {
    return getUsageAnalyticsQueryRequestKey({ ...query, costMode: undefined,
        ...(query.dateRange ? { dateRange: { ...query.dateRange, endMs: undefined } } : {}) });
}

/** Witness and selective dependency hydration share the caller's read-only snapshot. */
export async function captureUsageActivitySummaryInTx(tx: Tx, accountId: string,
    query: UsageAnalyticsQueryRequest): Promise<CapturedUsageActivitySummary> {
    const [expectedHead, changes, priceCatalog] = await Promise.all([
        readUsageActivitySummaryHead(tx, accountId),
        readUsageActivitySourceChanges(tx, accountId, query.dateRange?.endMs),
        captureUsageModelPriceCatalogInTx(tx),
    ]);
    let head = readHead(expectedHead);
    const stats: CapturedUsageActivitySummary['stats'] = { eventsRead: 0, discoveryEventsRead: 0, historyEventsRead: 0,
        projectedRows: 0, tariffCalculations: 0, tariffReuses: 0, calendarTargetCalculations: 0, calendarTargetReuses: 0, subjectCount: head?.subjectCount ?? 0, replayedSubjects: 0, replayedEvents: 0 };
    const snapshot: UsageAnalyticsSnapshot = { rows: [], legacyReports: [], priceCatalog, messageCountsBySession: undefined };
    const state: CapturedUsageActivitySummary = { accountId, query, expectedHead, changes, snapshot,
        sourceDigest: head?.sourceDigest ?? '', pricingReuse: head?.pricingReuse, days: new Map(), stats };
    if (head && changes.length === 0) {
        state.compact = head.queryKey === getUsageAnalyticsQueryRequestKey(query) ? head.response
            : rebaseUsageAnalyticsSummaryEnd(head.response, head.query, query);
        if (state.compact) return state;
    }
    // A different coordinate/selection shape is rebuilt by the same canonical owners.
    if (head && projectionShape(head.query) !== projectionShape(query)) head = undefined;
    let routing: UsageActivityRoutingCapture;
    try { routing = await captureUsageActivityRoutingInTx(tx, accountId, query, changes, head); }
    catch (error) {
        if (!(error instanceof MissingUsageActivityRoutingChunk) || !head) throw error;
        head = undefined;
        routing = await captureUsageActivityRoutingInTx(tx, accountId, query, changes);
    }
    state.routing = routing;
    state.days = new Map(head?.days);
    snapshot.rows = routing.rows;
    snapshot.legacyReports = routing.legacyReports;
    stats.subjectCount = routing.subjectCount;
    stats.discoveryEventsRead = routing.discoveryEventsRead;
    stats.historyEventsRead = routing.historyEventsRead;
    stats.eventsRead = routing.discoveryEventsRead + routing.historyEventsRead;
    state.sourceDigest = usageActivityFingerprint(JSON.stringify([state.sourceDigest, query.dateRange?.endMs, changes]));
    return state;
}

/** Replay whole dirty subjects, then rebuild local days whose operands or canonical order changed. */
export function* projectUsageActivitySummarySteps(state: CapturedUsageActivitySummary,
    shouldYield: () => boolean, timing?: UsageQueryTiming): Generator<void, UsageAnalyticsQueryResponse, void> {
    if (state.compact) return state.compact;
    const routing = state.routing!;
    const rows = new Map(state.snapshot.rows.map(row => [row.id, toScopedUsageEventRow(row)]));
    for (const [id, row] of routing.reportRows) rows.set(id, row);
    const replay = createUsageActivitySubjectReplay({ sourceFingerprints: routing.sourceFingerprints });
    const dirty = new Set(routing.dirtySubjects.map(subject => subject.subjectKey));
    const replacements = new Map<number, OrderedOperand[]>();
    const changedDays = new Set(routing.orderChangedProjectionDays);
    const start = state.query.dateRange?.startMs ?? -Infinity;
    const end = state.query.dateRange?.endMs ?? Infinity;
    for (const subject of routing.dirtySubjects) {
        const subjectDays = new Map<number, OrderedOperand[]>();
        if (subject.current.selected) {
            const sources = subject.eventIds.map(id => {
                const row = rows.get(id);
                if (!row) throw new Error('Usage activity source changed within its admitted snapshot');
                return row;
            });
            const fold = () => replay.resolve(subject.subjectKey, sources, routing.ranks);
            const resolved = timing ? timing.measure('fold', fold) : fold();
            const sourceByRank = new Map(subject.eventIds.map(id => [routing.ranks.get(id), id]));
            const origins = new Map(resolved.totalContributions.map(row => [row.id, {
                rankEventId: sourceByRank.get(routing.ranks.get(row.id))!, coverageReasons: row.coverageReasons ?? [],
            }]));
            const selected = resolved.preparedContributions.filter(row => row.observedAtMs >= start && row.observedAtMs < end);
            const parts = projectUsageActivitySubjectProjectionFacts(selected, state.query);
            subject.current.projectionDays = parts.map(part => part.dayStartMs);
            for (const part of parts) {
                const operands: OrderedOperand[] = [];
                const dayOperands = replacements.get(part.dayStartMs) ?? [];
                for (const operand of part.operands) {
                    const origin = origins.get(readUsageActivityProjectionOperand(operand).id)!;
                    if (!origin.rankEventId) throw new Error('Usage activity contribution is missing its source rank');
                    const row = { subjectKey: subject.subjectKey, ...origin, operand };
                    operands.push(row);
                    dayOperands.push(row);
                }
                subjectDays.set(part.dayStartMs, operands);
                replacements.set(part.dayStartMs, dayOperands);
            }
        }
        subject.current.projectionWitnesses = [...subjectDays].map(([day, operands]) =>
            [day, usageActivityFingerprint(JSON.stringify(operands))]);
        const previous = new Map(subject.previous?.projectionWitnesses);
        const current = new Map(subject.current.projectionWitnesses);
        for (const day of new Set([...(subject.previous?.projectionDays ?? []), ...subject.current.projectionDays])) {
            if (previous.get(day) !== current.get(day) || !previous.has(day)) changedDays.add(day);
        }
        routing.chunks.set(usageActivitySubjectKey(subject.subjectKey), subject.current.sources.length > 0
            ? JSON.stringify(subject.current) : null);
        if (shouldYield()) yield;
    }
    state.stats.replayedSubjects = replay.stats.replayedSubjects;
    state.stats.replayedEvents = replay.stats.replayedEvents;
    for (const day of changedDays) {
        if (shouldYield()) yield;
        const raw = routing.operandChunks.get(day);
        const previous: OrderedOperand[] = raw === undefined ? [] : JSON.parse(raw);
        const operands = previous.filter(row => !dirty.has(row.subjectKey)).concat(replacements.get(day) ?? []);
        operands.sort((left, right) => {
            const leftRank = routing.ranks.get(left.rankEventId);
            const rightRank = routing.ranks.get(right.rankEventId);
            if (leftRank === undefined || rightRank === undefined) throw new Error('Usage activity day is missing its admitted source rank');
            return leftRank - rightRank || readUsageActivityProjectionOperand(left.operand).id.localeCompare(readUsageActivityProjectionOperand(right.operand).id);
        });
        state.stats.projectedRows += operands.length;
        if (operands.length > 0) state.days.set(day, {
            facts: projectUsageActivityProjectionDayFacts(operands.map(row => row.operand), state.query),
            coverage: projectUsageResultCoverageFacts(operands.map(row => readUsageActivityProjectionOperand(row.operand)),
                state.query, operands.flatMap(row => row.coverageReasons)),
        });
        else state.days.delete(day);
        routing.chunks.set(usageActivityProjectionDayKey(day), operands.length > 0 ? JSON.stringify(operands) : null);
        if (shouldYield()) yield;
    }
    if (shouldYield()) yield;
    const days = [...state.days].sort(([left], [right]) => left - right).map(([, value]) => value);
    const evidence = mergeUsageCoverageEvidence([
        ...[...routing.sourceCoverage].sort(([left], [right]) => left - right).map(([, value]) => value),
        ...routing.reportSources.flatMap(route => route.coverage ? [route.coverage] : []),
    ]);
    const coverage = projectUsageResultCoverage(mergeUsageResultCoverageFacts(days.map(day => day.coverage)), evidence, state.query);
    return mergeUsageActivityProjectionFacts(days.map(day => day.facts), state.query, coverage);
}

/** Publish only changed routing, subject and local-day operands after canonical delivery succeeds. */
export async function publishUsageActivitySummary(state: CapturedUsageActivitySummary,
    value: UsageAnalyticsQueryResponse, catalog: UsageModelPriceCatalog): Promise<void> {
    if (state.compact && !state.updatedPricingReuse) return;
    const query = state.query;
    const delivered = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1, priceCatalog: catalog,
        results: [{ query, value }] }, { queries: [query], includeContributions: false,
        contributionQueries: [], sessionQueries: [query] }, false));
    const result = delivered.results[0];
    if (!result || 'error' in result) throw new Error('Usage activity summary projection failed');
    // A catalog/mode refresh updates only the priced head; source witnesses and
    // retained operands still describe the same admitted read snapshot.
    const previous = state.compact ? readHead(state.expectedHead) : undefined;
    if (previous) {
        const head: SummaryHead = { ...previous, queryKey: getUsageAnalyticsQueryRequestKey(query), query,
            response: result.value, pricingReuse: state.updatedPricingReuse };
        state.stats.published = await saveUsageActivitySummary(state.accountId, state.expectedHead,
            JSON.stringify(head), new Map(), []);
        return;
    }
    const routing = state.routing!;
    const head: SummaryHead = { version: USAGE_ACTIVITY_SUMMARY_VERSION, format: 'selective-day-facts',
        queryKey: getUsageAnalyticsQueryRequestKey(query), query, sourceDigest: state.sourceDigest,
        subjectCount: state.stats.subjectCount, response: result.value, pricingReuse: state.updatedPricingReuse,
        sourceDays: [...routing.sourceDays].sort((left, right) => left - right),
        subjectKeys: [...routing.subjectKeys], sessionKeys: [...routing.sessionKeys],
        sourceCoverage: [...routing.sourceCoverage], reportSources: routing.reportSources,
        legacyReports: routing.legacyReports, projectionDays: [...state.days.keys()], days: [...state.days] };
    state.stats.published = await saveUsageActivitySummary(state.accountId, state.expectedHead, JSON.stringify(head), routing.chunks, state.changes);
}
