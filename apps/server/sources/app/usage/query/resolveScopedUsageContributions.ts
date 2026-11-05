import type { UsageAccountingCoverageReason, UsageAnalyticsQueryRequest, UsageObservationCost, UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageAnalyticsSourceContext } from "@happier-dev/protocol/usage/usageAnalyticsContracts";
import { readScopedUsageAccountingEvidence, type ScopedUsageAccountingEvidence, type ScopedUsageEvidenceRow } from './scopedUsageEventRow';

import { foldScopedUsageContributions } from "./scopedUsageContributionFold";
import { canMatchUsageFilters } from './usageQueryFilters';

export interface ScopedUsageEventRow {
    id: string;
    sessionId: string | null;
    observedAt: Date;
    createdAt: Date;
    agentId: string | null;
    backendMode: string | null;
    modelId: string | null;
    projectKey: string | null;
    workspaceId: string | null;
    machineId?: string | null;
    source: string | null;
    scope: string;
    isCumulative: boolean;
    turnId: string | null;
    externalKey?: string | null;
    requestCount?: number;
    teamCredentialResourceId?: string | null;
    teamCredentialActorAccountId?: string | null;
    teamCredentialExternalApiKeyId?: string | null;
    teamCredentialSourceCredentialId?: string | null;
    brokerMachineId?: string | null;
    credentialDeliveryMode?: string | null;
    metadata?: unknown;
    accountingEvidence?: ScopedUsageAccountingEvidence;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    tokens: UsageObservationTokens;
    cost: UsageObservationCost;
    contributingEventIds?: readonly string[];
}

export interface ScopedUsageContribution extends ScopedUsageEventRow {
    contributingEventIds: readonly string[];
    coverageReasons?: readonly UsageAccountingCoverageReason[];
}

export interface ResolvedScopedUsageContributions {
    totalContributions: ScopedUsageContribution[];
    bucketAttributions: ScopedUsageContribution[];
    coverageReasons: UsageAccountingCoverageReason[];
}

/** Eligibility and global order decided from complete, inexpensive replay evidence. */
export interface ScopedUsageReplayContext {
    selectedEventIds: ReadonlySet<string>;
    ranks: ReadonlyMap<string, number>;
}

type ScopedUsageReplayEvidence = Pick<ScopedUsageEventRow,
    'id' | 'sessionId' | 'agentId' | 'machineId' | 'metadata' | 'accountingEvidence'
    | 'source' | 'observedAt' | 'createdAt'>;

/** Capture path is not execution placement: admitted native replay may belong to a real Session. */
export function resolveUsageContributionSourceContext(row: Pick<ScopedUsageEventRow, "metadata" | "sessionId" | "accountingEvidence">): UsageAnalyticsSourceContext {
    const { accounting, subject } = readScopedUsageAccountingEvidence(row);
    const path = accounting?.path ?? "unknown";
    const execution = path === "runtime" && row.sessionId ? "happier"
        : path === "native" && subject && subject.linkedSessionId === row.sessionId && row.sessionId ? "happier"
        : path === "native" && subject && !subject.linkedSessionId && !row.sessionId ? "outside"
        : "unknown";
    return { path, execution };
}

export function usageAccountingSubjectKey(row: Pick<ScopedUsageEventRow,
    'id' | 'sessionId' | 'agentId' | 'machineId' | 'metadata' | 'accountingEvidence'>): string {
    // A witnessed native subject owns accounting across live and collector
    // rows; the real Session remains attribution on the selected contribution.
    const { accounting, subject } = readScopedUsageAccountingEvidence(row);
    if (subject) {
        const native = subject;
        return JSON.stringify(["native", native.machineId, native.agent.pluginId, native.agent.localId,
            native.sourceRootKey, native.nativeSessionKey]);
    }
    if (row.sessionId) return JSON.stringify(["session", row.sessionId, row.agentId]);
    const nativeSessionId = accounting?.nativeSessionId;
    // Admission owns native identity. A missing subject cannot merge every
    // nullable Session row into one counter stream.
    return nativeSessionId
        ? JSON.stringify(["native", row.machineId, row.agentId, nativeSessionId])
        : JSON.stringify(["unidentified", row.id]);
}

function compareChronologically(left: ScopedUsageReplayEvidence, right: ScopedUsageReplayEvidence): number {
    const observedDifference = left.observedAt.getTime() - right.observedAt.getTime();
    if (observedDifference !== 0) return observedDifference;
    const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDifference !== 0) return createdDifference;
    return left.id.localeCompare(right.id);
}

export function orderRuntimeObservations<Row extends ScopedUsageReplayEvidence>(rows: readonly Row[]): Row[] {
    const ordered = [...rows].sort(compareChronologically);
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (end < ordered.length && ordered[end]!.observedAt.getTime() === ordered[start]!.observedAt.getTime()) end++;
        const streams = new Map<string, { slots: number[]; rows: Array<{ row: Row; sequence: number }> }>();
        for (let index = start; index < end; index++) {
            const row = ordered[index]!;
            const accounting = row.accountingEvidence?.accounting;
            const order = accounting?.path === 'runtime' ? accounting.runtimeEventOrder : undefined;
            if (!order) continue;
            const stream = streams.get(order.runtimeIncarnationId) ?? { slots: [], rows: [] };
            stream.slots.push(index);
            stream.rows.push({ row, sequence: order.sequence });
            streams.set(order.runtimeIncarnationId, stream);
        }
        for (const stream of streams.values()) {
            stream.rows.sort((left, right) => left.sequence - right.sequence || compareChronologically(left.row, right.row));
            stream.slots.forEach((slot, index) => { ordered[slot] = stream.rows[index]!.row; });
        }
        start = end;
    }
    return ordered;
}

/** Legacy reports are fallback only while their Session has no non-legacy Usage observation. */
export function selectScopedUsageEligibleRows<Row extends Pick<ScopedUsageEventRow, 'sessionId' | 'source'>>(rows: readonly Row[]): Row[] {
    const sessionsWithNativeUsage = new Set(rows.flatMap((row) => (
        row.sessionId && row.source !== 'legacy_usage_report' ? [row.sessionId] : []
    )));
    return rows.filter((row) => row.source !== 'legacy_usage_report'
        || !row.sessionId || !sessionsWithNativeUsage.has(row.sessionId));
}

/** A contribution retains its originating event's time; only its subject's history can change its fold. */
export function prepareScopedUsageReplayContext(rows: readonly ScopedUsageEvidenceRow[],
    range?: Readonly<{ startMs?: number; endMs?: number }>, filters?: UsageAnalyticsQueryRequest['filters']): ScopedUsageReplayContext {
    const beforeEnd = rows.filter(row => range?.endMs === undefined || row.observedAt.getTime() < range.endMs);
    const eligible = selectScopedUsageEligibleRows(beforeEnd);
    const subjects = new Map(eligible.map(row => [row.id, usageAccountingSubjectKey(row)]));
    const selectedSubjects = new Set(eligible
        .filter(row => (range?.startMs === undefined || row.observedAt.getTime() >= range.startMs)
            && canMatchUsageFilters(row, filters))
        .map(row => subjects.get(row.id)!));
    return {
        selectedEventIds: new Set(eligible.filter(row => selectedSubjects.has(subjects.get(row.id)!)).map(row => row.id)),
        ranks: new Map(orderRuntimeObservations(eligible).map((row, index) => [row.id, index])),
    };
}

function resolveGroup(rows: readonly ScopedUsageEventRow[], ranks: Map<string, number>): ResolvedScopedUsageContributions {
    return foldScopedUsageContributions(rows, ranks);
}

export function resolveScopedUsageContributions(
    rows: readonly ScopedUsageEventRow[],
    range?: Readonly<{ startMs?: number; endMs?: number }>,
    replayContext?: ScopedUsageReplayContext,
): ResolvedScopedUsageContributions {
    const steps = resolveScopedUsageContributionsSteps(rows, range, replayContext, () => false);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

/** Accounting subjects are independent fold units after global replay order is established. */
export function* resolveScopedUsageContributionsSteps(
    rows: readonly ScopedUsageEventRow[],
    range?: Readonly<{ startMs?: number; endMs?: number }>,
    replayContext?: ScopedUsageReplayContext,
    shouldYield: () => boolean = () => true,
): Generator<void, ResolvedScopedUsageContributions, void> {
    // DB rows arrive projected; in-memory callers share the same boundary once.
    rows = rows.map((row) => row.accountingEvidence ? row : { ...row, accountingEvidence: readScopedUsageAccountingEvidence(row) });
    const rowsById = replayContext ? new Map(rows.map(row => [row.id, row])) : undefined;
    const eligibleRows = replayContext
        ? [...replayContext.selectedEventIds].flatMap(id => {
            const row = rowsById!.get(id);
            return row ? [row] : [];
        })
        : selectScopedUsageEligibleRows(rows);
    // Reorder only the existing slots of one witnessed runtime at an equal
    // source instant. Pairwise same-runtime/else-created comparisons can cycle
    // across mixed streams; these fixed ranks govern reconciliation and output.
    // Monetary reconciliation adds derived contribution ranks; keep that state local to this projection.
    const ranks = replayContext ? new Map(replayContext.ranks)
        : new Map(orderRuntimeObservations(eligibleRows).map((row, index) => [row.id, index]));
    const compareRows = (left: ScopedUsageEventRow, right: ScopedUsageEventRow): number =>
        ranks.get(left.id)! - ranks.get(right.id)! || left.id.localeCompare(right.id);
    const groups = new Map<string, ScopedUsageEventRow[]>();
    for (const row of eligibleRows) {
        const key = usageAccountingSubjectKey(row);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }

    const totalContributions: ScopedUsageContribution[] = [];
    const bucketAttributions: ScopedUsageContribution[] = [];
    const coverageReasons = new Set<UsageAccountingCoverageReason>();
    for (const group of groups.values()) {
        const resolved = resolveGroup(group, ranks);
        const selected = resolved.totalContributions.filter((row) => (
            (range?.startMs === undefined || row.observedAt.getTime() >= range.startMs)
            && (range?.endMs === undefined || row.observedAt.getTime() < range.endMs)
        ));
        totalContributions.push(...selected);
        bucketAttributions.push(...selected);
        for (const row of selected) for (const reason of row.coverageReasons ?? []) coverageReasons.add(reason);
        if (shouldYield()) yield;
    }

    return {
        totalContributions: totalContributions.sort(compareRows),
        bucketAttributions: bucketAttributions.sort(compareRows),
        coverageReasons: [...coverageReasons],
    };
}
