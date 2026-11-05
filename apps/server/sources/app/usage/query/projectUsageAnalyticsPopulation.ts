import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { matchesUsageFilters } from './usageQueryFilters';
import type { UsageAnalyticsSnapshot } from '../usageQueryService';
import { LegacyUsageReportDataSchema, readLegacyUsageReportKey } from '../legacyUsageReportSchema';
import { normalizeLegacyUsageCost, normalizeLegacyUsageTokens } from '../usageMetrics';
import { prepareScopedUsageReplayContext, resolveScopedUsageContributionsSteps, usageAccountingSubjectKey,
    type ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { isPublicEligibleUsageRow, readScopedUsageAccountingEvidence, toScopedUsageEvidenceRow, toScopedUsageEventRow, toScopedUsageEventRowWithEvidence,
    type ScopedUsageEvidenceRow } from './scopedUsageEventRow';
import { resolveUsageCostMode } from './resolveUsageCostMode';
import type { UsageCoverageEvidence } from './projectUsageCoverageEvidence';

function resolveRetainedLegacyUsageRows(reports: UsageAnalyticsSnapshot['legacyReports'],
    bridgedRows: readonly Pick<ScopedUsageEventRow, 'source' | 'sessionId' | 'metadata'>[]): ScopedUsageEventRow[] {
    const bridged = new Set(bridgedRows.filter(row => row.source === 'legacy_usage_report')
        .map(row => JSON.stringify([row.sessionId, readLegacyUsageReportKey(row.metadata)])));
    const retainedKeys = new Set<string>();
    return reports.flatMap((report): ScopedUsageEventRow[] => {
        const key = JSON.stringify([report.sessionId, report.key]);
        if (retainedKeys.has(key)) return [];
        retainedKeys.add(key);
        if (bridged.has(key)) return [];
        const parsed = LegacyUsageReportDataSchema.safeParse(report.data);
        if (!parsed.success) return [];
        return [{ id: `legacy-report:${report.id}`, sessionId: report.sessionId,
            observedAt: report.updatedAt, createdAt: report.createdAt,
            agentId: 'legacy', backendMode: null, modelId: null, projectKey: null, workspaceId: null,
            machineId: null, source: 'legacy_usage_report', scope: 'turn_delta', isCumulative: false,
            turnId: null, contextUsedTokens: null, contextWindowTokens: null,
            tokens: normalizeLegacyUsageTokens(parsed.data.tokens), cost: normalizeLegacyUsageCost(parsed.data.cost),
            metadata: { usageAccounting: { path: 'legacy', status: 'unknown', historyComplete: false,
                asOfMs: report.updatedAt.getTime() } } }];
    });
}

export function normalizeUsageAnalyticsRows(snapshot: Pick<UsageAnalyticsSnapshot,
    'rows' | 'legacyReports' | 'evidenceRows' | 'normalizedEvidenceById'>): ScopedUsageEventRow[] {
    const steps = normalizeUsageAnalyticsRowsSteps(snapshot, () => false);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

function* normalizeUsageAnalyticsRowsSteps(snapshot: Pick<UsageAnalyticsSnapshot,
    'rows' | 'legacyReports' | 'evidenceRows' | 'normalizedEvidenceById'>, shouldYield: () => boolean) {
    const rows: ScopedUsageEventRow[] = [];
    for (const row of snapshot.rows) {
        const evidence = snapshot.normalizedEvidenceById?.get(row.id);
        rows.push(evidence ? toScopedUsageEventRowWithEvidence(row, evidence) : toScopedUsageEventRow(row));
        if (shouldYield()) yield;
    }
    for (const row of resolveRetainedLegacyUsageRows(snapshot.legacyReports, snapshot.evidenceRows ?? snapshot.rows)) {
        rows.push({ ...row, accountingEvidence: readScopedUsageAccountingEvidence(row) });
        if (shouldYield()) yield;
    }
    return rows;
}

/** Bridge admission is shared by full folds and thin historical coverage. */
export function normalizeUsageAnalyticsEvidenceRows<Row extends Pick<ScopedUsageEventRow, 'source' | 'sessionId' | 'metadata'>>(
    rows: readonly Row[], reports: UsageAnalyticsSnapshot['legacyReports']): (Row | ScopedUsageEvidenceRow)[] {
    return [...rows, ...resolveRetainedLegacyUsageRows(reports, rows)
        .map(row => ({ ...row, accountingEvidence: readScopedUsageAccountingEvidence(row) }))];
}

/** Read results stay opaque until commit; hydrate only complete demanded subjects here. */
export function prepareUsageAnalyticsSnapshot(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest): UsageAnalyticsSnapshot {
    const steps = prepareUsageAnalyticsSnapshotSteps(snapshot, request, () => false);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

function* prepareUsageAnalyticsSnapshotSteps(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest,
    shouldYield: () => boolean): Generator<void, UsageAnalyticsSnapshot, void> {
    const end = request.dateRange?.endMs;
    const sessions = request.filters?.sessionIds;
    const rows = end === undefined ? snapshot.rows : snapshot.rows.filter(row => row.observedAt.getTime() < end);
    const legacyReports = snapshot.legacyReports.filter(report => (end === undefined || report.updatedAt.getTime() < end)
        && (!sessions?.length || (report.sessionId !== null && sessions.includes(report.sessionId))));
    const normalized = [];
    const normalizedEvidenceById = new Map<string, ScopedUsageEvidenceRow>();
    for (const row of rows) {
        const evidence = toScopedUsageEvidenceRow(row);
        normalized.push(evidence);
        normalizedEvidenceById.set(evidence.id, evidence);
        if (shouldYield()) yield;
    }
    const evidenceRows = normalizeUsageAnalyticsEvidenceRows(normalized, legacyReports);
    const replayContext = prepareScopedUsageReplayContext(evidenceRows, request.dateRange, request.filters);
    return { ...snapshot, rows: rows.filter(row => replayContext.selectedEventIds.has(row.id)),
        legacyReports, evidenceRows, normalizedEvidenceById, replayContext };
}

/** Normalize, reconcile and select the committed population, independently of output demand. */
export function projectUsageAnalyticsPopulation(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest) {
    const steps = projectUsageAnalyticsPopulationSteps(snapshot, request, () => false);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

/** Preserve the synchronous projection while allowing batch readers to service I/O between subjects. */
export function* projectUsageAnalyticsPopulationSteps(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest,
    shouldYield: () => boolean = () => true) {
    const prepared = yield* prepareUsageAnalyticsSnapshotSteps(snapshot, request, shouldYield);
    const scopedRows = yield* normalizeUsageAnalyticsRowsSteps(prepared, shouldYield);
    const resolved = yield* resolveScopedUsageContributionsSteps(scopedRows, request.dateRange, prepared.replayContext, shouldYield);
    // Baselines remain until reconciliation; earlier filtering manufactures residuals.
    const publicPopulation = request.population === 'public_eligible_personal';
    const population = publicPopulation ? resolved.totalContributions.filter(isPublicEligibleUsageRow) : resolved.totalContributions;
    const costMode = resolveUsageCostMode(request.costMode);
    const totalContributions = population.filter(row => matchesUsageFilters(row, request.filters));
    let evidenceRows: readonly (ScopedUsageEvidenceRow | ScopedUsageEventRow)[] = prepared.evidenceRows ?? scopedRows;
    if (publicPopulation || request.filters?.execution !== undefined) {
        const selectedEventIds = new Set(totalContributions.flatMap(row => row.contributingEventIds));
        evidenceRows = evidenceRows.filter(row => selectedEventIds.has(row.id) && (!publicPopulation || isPublicEligibleUsageRow(row)));
    } else {
        const selectedSubjects = new Set(totalContributions.map(usageAccountingSubjectKey));
        evidenceRows = evidenceRows.filter(row => selectedSubjects.has(usageAccountingSubjectKey(row))
            || matchesUsageFilters(row, request.filters));
    }
    return { totalContributions, evidenceRows, costMode };
}

export type UsageAnalyticsPopulation = ReturnType<typeof projectUsageAnalyticsPopulation> & { coverageEvidence?: UsageCoverageEvidence };
