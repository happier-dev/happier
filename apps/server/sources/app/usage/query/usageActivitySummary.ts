import { createHash } from 'node:crypto';
import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsContribution, type UsageAnalyticsQueryRequest, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery } from '@happier-dev/protocol/usage/usageAnalyticsBatchDelivery';
import type { UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { rebaseUsageAnalyticsSummaryEnd } from '@happier-dev/protocol/usage/usageSummary';
import type { Tx } from '@/storage/inTx';
import type { UsageAnalyticsSnapshot } from '../usageQueryService';
import { captureUsageModelPriceCatalogInTx } from '../usageModelPriceCatalog';
import { loadRetainedLegacyUsageReports, loadUsageEventsForQuery, type UsageQueryEvent } from './loadUsageEventsForQuery';
import { toScopedUsageEvidenceRow, toScopedUsageEventRow } from './scopedUsageEventRow';
import { createUsageActivitySubjectReplay, type UsageActivitySubjectReplayEntry, type UsageActivitySubjectReplayPlan,
    type UsageActivitySubjectReplayStats } from './usageActivitySubjectReplay';
import { toScopedUsageReplayFact, type ScopedUsageReplayFact, type ScopedUsageContribution, type ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { resolveUsageLegacyReportRows, toUsageLegacyBridgeFacts, type UsageLegacyBridgeFact, type UsageAnalyticsPopulation } from './projectUsageAnalyticsPopulation';
import { mergeUsageCoverageEvidence, projectUsageCoverageEvidence, type UsageCoverageEvidence } from './projectUsageCoverageEvidence';
import { resolveUsageCostMode } from './resolveUsageCostMode';
import { readUsageActivitySourceChanges, readUsageActivitySummaryChunks, readUsageActivitySummaryHead,
    saveUsageActivitySummary, USAGE_ACTIVITY_SUMMARY_VERSION, type UsageActivitySourceChange } from './usageActivitySummaryStore';

const dayMs = 86_400_000;
const dayFor = (time: number) => Math.floor(time / dayMs) * dayMs;
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const indexKey = (day: number) => `index:${day}`;
const subjectsKey = (day: number) => `subjects:${day}`;

interface SourceIndex {
    facts: Array<{ fact: ScopedUsageReplayFact; fingerprint: string }>;
    coverage: UsageCoverageEvidence;
    bridges: UsageLegacyBridgeFact[];
}

interface SummaryHead {
    version: typeof USAGE_ACTIVITY_SUMMARY_VERSION;
    format: 'day-facts';
    queryKey: string;
    query: UsageAnalyticsQueryRequest;
    sourceDigest: string;
    subjectCount: number;
    response: UsageAnalyticsQueryResponse;
    sourceDays: number[];
    subjectDays: number[];
    legacyReports: UsageAnalyticsSnapshot['legacyReports'];
}

/** Captured read-owned advance. No event admission or ingestion consults this state. */
export interface CapturedUsageActivitySummary {
    accountId: string;
    query: UsageAnalyticsQueryRequest;
    expectedHead: string | null;
    changes: readonly UsageActivitySourceChange[];
    sourceDigest: string;
    snapshot: UsageAnalyticsSnapshot;
    compact?: UsageAnalyticsQueryResponse;
    indexes: Map<number, SourceIndex>;
    changedIndexDays: Set<number>;
    retained: Map<string, UsageActivitySubjectReplayEntry>;
    retainedSubjectDays: Map<string, number>;
    subjectDays: Map<string, number>;
    plan?: UsageActivitySubjectReplayPlan;
    reportRows: ScopedUsageEventRow[];
    stats: UsageActivitySubjectReplayStats & {
        eventsRead: number;
        discoveryEventsRead: number;
        historyEventsRead: number;
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
        || Reflect.get(value, 'format') !== 'day-facts') return undefined;
    // This versioned internal projection is written by this owner; wire admission stays at delivery.
    const head = value as SummaryHead;
    for (const report of head.legacyReports) {
        report.createdAt = new Date(report.createdAt);
        report.updatedAt = new Date(report.updatedAt);
    }
    return head;
}

function makeIndex(rows: readonly UsageQueryEvent[]): { index: SourceIndex; admitted: UsageQueryEvent[] } {
    const admitted = rows.map(toScopedUsageEvidenceRow);
    return { admitted, index: {
        facts: admitted.map((row, index) => ({ fact: toScopedUsageReplayFact(row), fingerprint: fingerprint(JSON.stringify(rows[index])) })),
        coverage: projectUsageCoverageEvidence(admitted),
        bridges: toUsageLegacyBridgeFacts(admitted),
    } };
}

/** Witness, reduced facts and changed subject hydration share the caller's read-only snapshot. */
export async function captureUsageActivitySummaryInTx(tx: Tx, accountId: string,
    query: UsageAnalyticsQueryRequest): Promise<CapturedUsageActivitySummary> {
    const [expectedHead, changes, priceCatalog] = await Promise.all([
        readUsageActivitySummaryHead(tx, accountId),
        readUsageActivitySourceChanges(tx, accountId, query.dateRange?.endMs),
        captureUsageModelPriceCatalogInTx(tx),
    ]);
    let head = readHead(expectedHead);
    const stats: CapturedUsageActivitySummary['stats'] = { eventsRead: 0, discoveryEventsRead: 0, historyEventsRead: 0,
        subjectCount: head?.subjectCount ?? 0, replayedSubjects: 0, replayedEvents: 0 };
    const snapshot: UsageAnalyticsSnapshot = { rows: [], legacyReports: [], priceCatalog, messageCountsBySession: undefined };
    const state: CapturedUsageActivitySummary = { accountId, query, expectedHead, changes, snapshot,
        sourceDigest: head?.sourceDigest ?? '', indexes: new Map(), changedIndexDays: new Set(), retained: new Map(),
        retainedSubjectDays: new Map(), subjectDays: new Map(), reportRows: [], stats };
    if (head && changes.length === 0) {
        state.compact = head.queryKey === getUsageAnalyticsQueryRequestKey(query) ? head.response
            : rebaseUsageAnalyticsSummaryEnd(head.response, head.query, query);
        if (state.compact) return state;
    }
    if (head) {
        const keys = [...head.sourceDays.map(indexKey), ...head.subjectDays.map(subjectsKey)];
        const chunks = await readUsageActivitySummaryChunks(tx, accountId, keys);
        // A removed reconstructible chunk causes a cold rebuild, never partial accounting.
        if (keys.some(key => !chunks.has(key))) head = undefined;
        else {
            for (const day of head.sourceDays) state.indexes.set(day, JSON.parse(chunks.get(indexKey(day))!) as SourceIndex);
            for (const day of head.subjectDays) {
                const entries = JSON.parse(chunks.get(subjectsKey(day))!) as Array<[string, UsageActivitySubjectReplayEntry]>;
                for (const [key, entry] of entries) {
                    state.retained.set(key, entry);
                    state.retainedSubjectDays.set(key, day);
                }
            }
        }
    }
    const changedDays = changes.filter(change => change.kind === 'event').map(change => change.dayStartMs);
    const loaded = await loadUsageEventsForQuery(tx, accountId, query, undefined,
        head ? changes.filter(change => change.kind === 'event' && change.fingerprint !== null).map(change => change.dayStartMs) : undefined);
    stats.discoveryEventsRead = loaded.length;
    const loadedByDay = new Map<number, UsageQueryEvent[]>();
    for (const row of loaded) {
        const day = dayFor(row.observedAt.getTime());
        const rows = loadedByDay.get(day) ?? [];
        rows.push(row);
        loadedByDay.set(day, rows);
    }
    const loadedById = new Map(loaded.map(row => [row.id, row]));
    state.changedIndexDays = new Set(head ? changedDays : [...(readHead(expectedHead)?.sourceDays ?? []), ...loadedByDay.keys()]);
    for (const day of state.changedIndexDays) {
        const rows = loadedByDay.get(day);
        if (rows?.length) {
            const { index, admitted } = makeIndex(rows);
            state.indexes.set(day, index);
            for (const row of admitted) loadedById.set(row.id, row);
        }
        else state.indexes.delete(day);
    }
    snapshot.legacyReports = !head || changes.some(change => change.kind === 'report')
        ? await loadRetainedLegacyUsageReports(tx, accountId, query) : head.legacyReports;
    const indexes = [...state.indexes].sort(([left], [right]) => left - right).map(([, index]) => index);
    state.reportRows = resolveUsageLegacyReportRows(snapshot.legacyReports, indexes.flatMap(index => index.bridges));
    const sourceFingerprints = new Map(indexes.flatMap(index => index.facts.map(row => [row.fact.id, row.fingerprint] as const)));
    for (const report of snapshot.legacyReports) sourceFingerprints.set(`legacy-report:${report.id}`, fingerprint(JSON.stringify(report)));
    const replay = createUsageActivitySubjectReplay({ sourceFingerprints, retained: state.retained });
    const facts = [...indexes.flatMap(index => index.facts.map(row => row.fact)), ...state.reportRows.map(toScopedUsageReplayFact)];
    state.plan = replay.plan(facts, query.dateRange);
    snapshot.subjectReplay = replay;
    for (const fact of facts) {
        const previous = state.subjectDays.get(fact.subjectKey);
        const day = dayFor(fact.observedAtMs);
        if (previous === undefined || day < previous) state.subjectDays.set(fact.subjectKey, day);
    }
    const reportIds = new Set(state.reportRows.map(row => row.id));
    const neededIds = state.plan.subjects.filter(subject => subject.needsReplay).flatMap(subject => subject.eventIds)
        .filter(id => !reportIds.has(id));
    const missingIds = neededIds.filter(id => !loadedById.has(id));
    const historical = await loadUsageEventsForQuery(tx, accountId, query, missingIds);
    stats.historyEventsRead = historical.length;
    stats.eventsRead = loaded.length + historical.length;
    snapshot.rows = [...neededIds.flatMap(id => {
        const row = loadedById.get(id);
        return row ? [row] : [];
    }), ...historical];
    state.sourceDigest = fingerprint(JSON.stringify([state.sourceDigest, query.dateRange?.endMs, changes]));
    return state;
}

/** Reuse admitted subject outputs, replaying changed subjects through the one accounting fold. */
export function* projectUsageActivitySummaryPopulationSteps(state: CapturedUsageActivitySummary,
    shouldYield: () => boolean): Generator<void, UsageAnalyticsPopulation, void> {
    const rows = new Map<string, ScopedUsageEventRow>();
    for (const row of state.snapshot.rows) {
        rows.set(row.id, toScopedUsageEventRow(row));
        if (shouldYield()) yield;
    }
    for (const row of state.reportRows) rows.set(row.id, row);
    const ranks = new Map(state.plan!.replayContext.ranks);
    const selected: Array<{ row: ScopedUsageContribution; prepared: UsageAnalyticsContribution }> = [];
    const start = state.query.dateRange?.startMs ?? -Infinity;
    const end = state.query.dateRange?.endMs ?? Infinity;
    for (const subject of state.plan!.subjects) {
        const resolved = state.snapshot.subjectReplay!.resolvePlanned(subject,
            subject.needsReplay ? subject.eventIds.map(id => {
                const row = rows.get(id);
                if (!row) throw new Error('Usage activity source changed within its admitted snapshot');
                return row;
            }) : undefined, ranks);
        resolved.totalContributions.forEach((row, index) => {
            const time = row.observedAt.getTime();
            if (time >= start && time < end) selected.push({ row, prepared: resolved.preparedContributions[index]! });
        });
        if (shouldYield()) yield;
    }
    selected.sort((left, right) => ranks.get(left.row.id)! - ranks.get(right.row.id)! || left.row.id.localeCompare(right.row.id));
    return {
        totalContributions: selected.map(pair => pair.row), preparedContributions: selected.map(pair => pair.prepared),
        evidenceRows: [], costMode: resolveUsageCostMode(state.query.costMode),
        coverageEvidence: mergeUsageCoverageEvidence([
            ...[...state.indexes].sort(([left], [right]) => left - right).map(([, index]) => index.coverage),
            projectUsageCoverageEvidence(state.reportRows),
        ]),
    };
}

/** Publish only changed day containers after the canonical projection and membership succeed. */
export async function publishUsageActivitySummary(state: CapturedUsageActivitySummary,
    value: UsageAnalyticsQueryResponse, catalog: UsageModelPriceCatalog): Promise<void> {
    if (state.compact) return;
    const query = state.query;
    const delivered = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1, priceCatalog: catalog,
        results: [{ query, value }] }, { queries: [query], includeContributions: false,
        contributionQueries: [], sessionQueries: [query] }, false));
    const result = delivered.results[0];
    if (!result || 'error' in result) throw new Error('Usage activity summary projection failed');
    const replay = state.snapshot.subjectReplay!;
    Object.assign(state.stats, replay.stats);
    const byDay = new Map<number, Array<[string, UsageActivitySubjectReplayEntry]>>();
    const changedDays = new Set<number>();
    for (const [key, entry] of replay.entries) {
        const day = state.subjectDays.get(key)!;
        const entries = byDay.get(day) ?? [];
        entries.push([key, entry]);
        byDay.set(day, entries);
        const previousDay = state.retainedSubjectDays.get(key);
        if (entry !== state.retained.get(key) || previousDay !== day) {
            changedDays.add(day);
            if (previousDay !== undefined) changedDays.add(previousDay);
        }
    }
    for (const [key] of state.retained) if (!replay.entries.has(key)) changedDays.add(state.retainedSubjectDays.get(key)!);
    const updates = new Map<string, string | null>();
    for (const day of state.changedIndexDays) {
        const index = state.indexes.get(day);
        updates.set(indexKey(day), index ? JSON.stringify(index) : null);
    }
    for (const day of changedDays) {
        const entries = byDay.get(day);
        updates.set(subjectsKey(day), entries?.length ? JSON.stringify(entries) : null);
    }
    const head: SummaryHead = { version: USAGE_ACTIVITY_SUMMARY_VERSION, format: 'day-facts',
        queryKey: getUsageAnalyticsQueryRequestKey(query), query, sourceDigest: state.sourceDigest,
        subjectCount: replay.stats.subjectCount, response: result.value,
        sourceDays: [...state.indexes.keys()].sort((left, right) => left - right),
        subjectDays: [...byDay.keys()].sort((left, right) => left - right), legacyReports: state.snapshot.legacyReports };
    state.stats.published = await saveUsageActivitySummary(state.accountId, state.expectedHead, JSON.stringify(head), updates, state.changes);
}
