import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsContribution, type UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { matchesUsageFilters } from './usageQueryFilters';
import type { UsageAnalyticsSnapshot } from '../usageQueryService';
import { LegacyUsageReportDataSchema, legacyUsageReportAgentId, readLegacyUsageReportKey } from '../legacyUsageReportSchema';
import { normalizeLegacyUsageCost, normalizeLegacyUsageTokens } from '../usageMetrics';
import { prepareScopedUsageReplayBasis, resolveScopedUsageContributionsSteps, selectScopedUsageReplayContext, usageAccountingSubjectKey,
    type ScopedUsageContribution, type ScopedUsageEventRow } from './resolveScopedUsageContributions';
import { isPublicEligibleUsageRow, readKeyedUsageThread, readScopedUsageAccountingEvidence, toScopedUsageEvidenceRow, toScopedUsageEventRow, toScopedUsageEventRowWithEvidence,
    type ScopedUsageEvidenceRow } from './scopedUsageEventRow';
import { resolveUsageCostMode } from './resolveUsageCostMode';
import type { UsageCoverageEvidence } from './projectUsageCoverageEvidence';

export interface UsageLegacyBridgeFact {
    sessionId: string | null;
    key: string | null;
}

/** Retain bridge identity without retaining or reconstructing source metadata. */
export function toUsageLegacyBridgeFacts(rows: readonly Pick<ScopedUsageEventRow,
    'source' | 'sessionId' | 'metadata'>[]): UsageLegacyBridgeFact[] {
    return rows.filter(row => row.source === 'legacy_usage_report')
        .map(row => ({ sessionId: row.sessionId, key: readLegacyUsageReportKey(row.metadata) }));
}

/** Canonical report fallback consumes complete admitted bridge identities. */
export function resolveUsageLegacyReportRows(reports: UsageAnalyticsSnapshot['legacyReports'],
    bridges: readonly UsageLegacyBridgeFact[]): ScopedUsageEventRow[] {
    const bridged = new Set(bridges.map(row => JSON.stringify([row.sessionId, row.key])));
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
            agentId: legacyUsageReportAgentId, backendMode: null, modelId: null, projectKey: null, workspaceId: null,
            machineId: null, source: 'legacy_usage_report', scope: 'turn_delta', isCumulative: false,
            turnId: null, contextUsedTokens: null, contextWindowTokens: null,
            tokens: normalizeLegacyUsageTokens(parsed.data.tokens), cost: normalizeLegacyUsageCost(parsed.data.cost),
            metadata: { usageAccounting: { path: 'legacy', status: 'unknown', historyComplete: false,
                asOfMs: report.updatedAt.getTime() } } }];
    });
}

function resolveRetainedLegacyUsageRows(reports: UsageAnalyticsSnapshot['legacyReports'],
    bridgedRows: readonly Pick<ScopedUsageEventRow, 'source' | 'sessionId' | 'metadata'>[]): ScopedUsageEventRow[] {
    return resolveUsageLegacyReportRows(reports, toUsageLegacyBridgeFacts(bridgedRows));
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

function historicalUsageRows(snapshot: UsageAnalyticsSnapshot) {
    return snapshot.rawEvidenceRows ?? snapshot.evidenceRows ?? snapshot.rows;
}

interface PreparedUsageAnalyticsHistory {
    legacyReports: UsageAnalyticsSnapshot['legacyReports'];
    evidenceRows: ScopedUsageEvidenceRow[];
    normalizedEvidenceById: ReadonlyMap<string, ScopedUsageEvidenceRow>;
    basis: ReturnType<typeof prepareScopedUsageReplayBasis>;
}

function* prepareUsageAnalyticsHistorySteps(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest,
    shouldYield: () => boolean): Generator<void, PreparedUsageAnalyticsHistory, void> {
    const end = request.dateRange?.endMs;
    const sessionIds = request.filters?.sessionIds;
    const sessions = sessionIds?.length ? new Set(sessionIds) : undefined;
    const historicalRows = historicalUsageRows(snapshot);
    const isMember = (sessionId: string | null) => !sessions || (sessionId !== null && sessions.has(sessionId));
    const rows = end === undefined ? historicalRows : historicalRows.filter(row => row.observedAt.getTime() < end);
    const legacyReports = snapshot.legacyReports.filter(report => (end === undefined || report.updatedAt.getTime() < end)
        && isMember(report.sessionId));
    const normalized: ScopedUsageEvidenceRow[] = [];
    const normalizedEvidenceById = new Map<string, ScopedUsageEvidenceRow>();
    for (const row of rows) {
        const evidence = snapshot.normalizedEvidenceById?.get(row.id)
            ?? (row.accountingEvidence ? { ...row, accountingEvidence: row.accountingEvidence } : toScopedUsageEvidenceRow(row));
        // An opaque key correlates accounting rows without conferring Session membership.
        if (isMember(evidence.sessionId) || !readKeyedUsageThread(evidence)) {
            normalized.push(evidence);
            normalizedEvidenceById.set(evidence.id, evidence);
        }
        if (shouldYield()) yield;
    }
    const evidenceRows = normalizeUsageAnalyticsEvidenceRows(normalized, legacyReports);
    return { legacyReports, evidenceRows, normalizedEvidenceById, basis: prepareScopedUsageReplayBasis(evidenceRows) };
}

export type UsageAnalyticsReplayPreparation = typeof prepareUsageAnalyticsHistorySteps;

/** Ordered evidence is shared only among compatible historical scopes of one capture. */
export function createUsageAnalyticsReplayPreparation(): UsageAnalyticsReplayPreparation {
    type CapturedHistory = {
        legacyReports: UsageAnalyticsSnapshot['legacyReports'];
        normalizedEvidenceById?: UsageAnalyticsSnapshot['normalizedEvidenceById'];
        prepared: PreparedUsageAnalyticsHistory;
    };
    const histories = new WeakMap<ReturnType<typeof historicalUsageRows>, Map<string, CapturedHistory[]>>();
    return function* (snapshot, request, shouldYield) {
        const rows = historicalUsageRows(snapshot);
        // Start and ordinary filters select subjects after ordering. Session
        // membership is part of the historical scope that enters the fold.
        const scope = JSON.stringify([request.dateRange?.endMs,
            request.filters?.sessionIds?.length ? request.filters.sessionIds : undefined]);
        const scopes = histories.get(rows) ?? new Map<string, CapturedHistory[]>();
        const entries = scopes.get(scope) ?? [];
        const existing = entries.find(entry => entry.legacyReports === snapshot.legacyReports
            && entry.normalizedEvidenceById === snapshot.normalizedEvidenceById);
        if (existing) return existing.prepared;
        const prepared = yield* prepareUsageAnalyticsHistorySteps(snapshot, request, shouldYield);
        entries.push({ legacyReports: snapshot.legacyReports, normalizedEvidenceById: snapshot.normalizedEvidenceById, prepared });
        scopes.set(scope, entries);
        histories.set(rows, scopes);
        return prepared;
    };
}

/** Read results stay opaque until commit; hydrate only complete demanded subjects here. */
export function prepareUsageAnalyticsSnapshot(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest,
    prepareHistory?: UsageAnalyticsReplayPreparation): UsageAnalyticsSnapshot {
    const steps = prepareUsageAnalyticsSnapshotSteps(snapshot, request, () => false, prepareHistory);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

export function* prepareUsageAnalyticsSnapshotSteps(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest,
    shouldYield: () => boolean, prepareHistory: UsageAnalyticsReplayPreparation = prepareUsageAnalyticsHistorySteps):
    Generator<void, UsageAnalyticsSnapshot, void> {
    const preparedQueryKey = getUsageAnalyticsQueryRequestKey(request);
    if (snapshot.replayContext && snapshot.preparedQueryKey === preparedQueryKey) return snapshot;
    const history = yield* prepareHistory(snapshot, request, shouldYield);
    const replayContext = selectScopedUsageReplayContext(history.basis, request.dateRange?.startMs, request.filters);
    return { ...snapshot, rows: snapshot.rows.filter(row => replayContext.selectedEventIds.has(row.id)),
        legacyReports: history.legacyReports, evidenceRows: history.evidenceRows, rawEvidenceRows: undefined,
        normalizedEvidenceById: history.normalizedEvidenceById, replayContext, preparedQueryKey };
}

/** Normalize, reconcile and select the committed population, independently of output demand. */
export function projectUsageAnalyticsPopulation(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest): UsageAnalyticsPopulation {
    const steps = projectUsageAnalyticsPopulationSteps(snapshot, request, () => false);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

/** Preserve the synchronous projection while allowing batch readers to service I/O between subjects. */
export function* projectUsageAnalyticsPopulationSteps(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest,
    shouldYield: () => boolean = () => true, prepareHistory?: UsageAnalyticsReplayPreparation):
    Generator<void, UsageAnalyticsPopulation, void> {
    const prepared = yield* prepareUsageAnalyticsSnapshotSteps(snapshot, request, shouldYield, prepareHistory);
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
        const start = request.dateRange?.startMs;
        evidenceRows = evidenceRows.filter(row => (!publicPopulation || isPublicEligibleUsageRow(row))
            && (selectedEventIds.has(row.id)
                // A reconciled keyed source witnesses its own window even with zero usage.
                || (resolved.reconciledEvidenceIds?.has(row.id)
                    && (start === undefined || row.observedAt.getTime() >= start)
                    && matchesUsageFilters(row, request.filters))));
    } else {
        // Replay admission already established every captured event's identity.
        // Only newly derived report contributions lack an admitted event key.
        const subjectFor = (row: Parameters<typeof usageAccountingSubjectKey>[0]) =>
            prepared.replayContext?.subjects.get(row.id) ?? usageAccountingSubjectKey(row);
        const selectedSubjects = new Set(totalContributions.map(subjectFor));
        evidenceRows = evidenceRows.filter(row => selectedSubjects.has(subjectFor(row))
            || matchesUsageFilters(row, request.filters));
    }
    return { totalContributions, evidenceRows, costMode };
}

export interface UsageAnalyticsPopulation {
    totalContributions: ScopedUsageContribution[];
    evidenceRows: readonly (ScopedUsageEvidenceRow | ScopedUsageEventRow)[];
    costMode: ReturnType<typeof resolveUsageCostMode>;
    coverageEvidence?: UsageCoverageEvidence;
    /** Canonical result facts aligned with the selected scoped contributions by their admission owner. */
    preparedContributions?: readonly UsageAnalyticsContribution[];
}
