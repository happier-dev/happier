import type { UsageAccountingCoverageReason, UsageAccountingMetadata, UsageAnalyticsQueryRequest, UsageAnalyticsTokens, UsageObservationCost, UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageAnalyticsSourceContext } from "@happier-dev/protocol/usage/usageAnalyticsContracts";
import { readScopedUsageAccountingEvidence, type ScopedUsageAccountingEvidence, type ScopedUsageEvidenceRow } from './scopedUsageEventRow';

import { foldReleasedUsageContributions, foldScopedUsageContributions } from "./scopedUsageContributionFold";
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
    tokens: UsageAnalyticsTokens;
    contributingEventIds: readonly string[];
    coverageReasons?: readonly UsageAccountingCoverageReason[];
}

export interface ResolvedScopedUsageContributions {
    totalContributions: ScopedUsageContribution[];
    bucketAttributions: ScopedUsageContribution[];
    coverageReasons: UsageAccountingCoverageReason[];
    reconciledEvidenceIds?: ReadonlySet<string>;
}

/** Eligibility and global order decided from complete, inexpensive replay evidence. */
export interface ScopedUsageReplayContext {
    selectedEventIds: ReadonlySet<string>;
    ranks: ReadonlyMap<string, number>;
    subjects: ReadonlyMap<string, string>;
}

type ScopedUsageReplayEvidence = Pick<ScopedUsageEventRow,
    'id' | 'sessionId' | 'agentId' | 'machineId' | 'metadata' | 'accountingEvidence'
    | 'source' | 'observedAt' | 'createdAt'>;

/** Read-owned identity/order facts; unchanged sources need no monetary or metadata body. */
export interface ScopedUsageReplayFact {
    id: string;
    sessionId: string | null;
    source: string | null;
    observedAtMs: number;
    createdAtMs: number;
    subjectKey: string;
    runtimeEventOrder?: UsageAccountingMetadata['runtimeEventOrder'];
}

export function toScopedUsageReplayFact(row: ScopedUsageReplayEvidence): ScopedUsageReplayFact {
    const { accounting } = readScopedUsageAccountingEvidence(row);
    return { id: row.id, sessionId: row.sessionId, source: row.source,
        observedAtMs: row.observedAt.getTime(), createdAtMs: row.createdAt.getTime(),
        subjectKey: usageAccountingSubjectKey(row),
        ...(accounting?.path === 'runtime' && accounting.runtimeEventOrder
            ? { runtimeEventOrder: accounting.runtimeEventOrder } : {}) };
}

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

export type ScopedUsageSubjectIdentity = readonly ['native-stream', string]
    | readonly ['native', string, string, string, string, string]
    | readonly ['session', string, string | null]
    | readonly ['native', string | null, string | null, string]
    | readonly ['unidentified', string];

export function usageAccountingSubjectIdentity(row: Pick<ScopedUsageEventRow,
    'id' | 'sessionId' | 'agentId' | 'machineId' | 'metadata' | 'accountingEvidence'>): ScopedUsageSubjectIdentity {
    // A witnessed native subject owns accounting across live and collector
    // rows; the real Session remains attribution on the selected contribution.
    const { accounting, subject } = readScopedUsageAccountingEvidence(row);
    if (accounting?.nativeSessionKey) return ['native-stream', accounting.nativeSessionKey];
    if (subject) {
        const native = subject;
        return ["native", native.machineId, native.agent.pluginId, native.agent.localId,
            native.sourceRootKey, native.nativeSessionKey];
    }
    const nativeSessionId = accounting?.nativeSessionId;
    // Child native Sessions can share the parent's Happier Session attribution;
    // their witnessed native counter identity must remain independent.
    if (nativeSessionId) return ["native", row.machineId ?? null, row.agentId, nativeSessionId];
    if (row.sessionId) return ["session", row.sessionId, row.agentId];
    // Admission owns native identity. A missing subject cannot merge every
    // nullable Session row into one counter stream.
    return ["unidentified", row.id];
}

export function usageAccountingSubjectKey(row: Parameters<typeof usageAccountingSubjectIdentity>[0]): string {
    return JSON.stringify(usageAccountingSubjectIdentity(row));
}

type ScopedUsageReplayOrderRow = ScopedUsageReplayEvidence | ScopedUsageReplayFact;

function observedAtMs(row: ScopedUsageReplayOrderRow): number {
    return 'observedAtMs' in row ? row.observedAtMs : row.observedAt.getTime();
}

function compareChronologically(left: ScopedUsageReplayOrderRow, right: ScopedUsageReplayOrderRow): number {
    const observedDifference = observedAtMs(left) - observedAtMs(right);
    if (observedDifference !== 0) return observedDifference;
    const createdDifference = ('createdAtMs' in left ? left.createdAtMs : left.createdAt.getTime())
        - ('createdAtMs' in right ? right.createdAtMs : right.createdAt.getTime());
    if (createdDifference !== 0) return createdDifference;
    return left.id.localeCompare(right.id);
}

export function orderRuntimeObservations<Row extends ScopedUsageReplayOrderRow>(rows: readonly Row[]): Row[] {
    const ordered = [...rows].sort(compareChronologically);
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (end < ordered.length && observedAtMs(ordered[end]!) === observedAtMs(ordered[start]!)) end++;
        const streams = new Map<string, { slots: number[]; rows: Array<{ row: Row; sequence: number }> }>();
        for (let index = start; index < end; index++) {
            const row = ordered[index]!;
            const accounting = 'observedAtMs' in row ? undefined : row.accountingEvidence?.accounting;
            const order = 'observedAtMs' in row ? row.runtimeEventOrder
                : accounting?.path === 'runtime' ? accounting.runtimeEventOrder : undefined;
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

/** Admission and chronological ranks depend on the captured historical scope. */
export function prepareScopedUsageReplayBasis(rows: readonly (ScopedUsageEvidenceRow | ScopedUsageReplayFact)[]) {
    const eligible = rows;
    return {
        eligible,
        subjects: new Map(eligible.map(row => [row.id, 'subjectKey' in row ? row.subjectKey : usageAccountingSubjectKey(row)])),
        ranks: new Map(orderRuntimeObservations(eligible).map((row, index) => [row.id, index])),
    };
}

export function selectScopedUsageReplayContext(basis: ReturnType<typeof prepareScopedUsageReplayBasis>,
    startMs?: number, filters?: UsageAnalyticsQueryRequest['filters']): ScopedUsageReplayContext {
    const { eligible, ranks, subjects } = basis;
    const selectedSubjects = new Set(eligible
        .filter(row => (startMs === undefined || observedAtMs(row) >= startMs)
            && ('subjectKey' in row || canMatchUsageFilters(row, filters)))
        .map(row => subjects.get(row.id)!));
    // A report in the view depends on linked modern history up to its
    // observation. Select those bodies even when they precede the window.
    const legacySessions = new Set(eligible.flatMap(row => row.sessionId && row.source === 'legacy_usage_report'
        && selectedSubjects.has(subjects.get(row.id)!) ? [row.sessionId] : []));
    if (legacySessions.size) {
        for (const row of eligible) {
            if (row.sessionId && legacySessions.has(row.sessionId)) selectedSubjects.add(subjects.get(row.id)!);
        }
    }
    return {
        selectedEventIds: new Set(eligible.filter(row => selectedSubjects.has(subjects.get(row.id)!)).map(row => row.id)),
        ranks,
        subjects,
    };
}

/** A contribution retains its originating event's time; only its subject's history can change its fold. */
export function prepareScopedUsageReplayContext(rows: readonly ScopedUsageReplayFact[],
    range?: Readonly<{ startMs?: number; endMs?: number }>): ScopedUsageReplayContext;
export function prepareScopedUsageReplayContext(rows: readonly ScopedUsageEvidenceRow[],
    range?: Readonly<{ startMs?: number; endMs?: number }>, filters?: UsageAnalyticsQueryRequest['filters']): ScopedUsageReplayContext;
export function prepareScopedUsageReplayContext(rows: readonly (ScopedUsageEvidenceRow | ScopedUsageReplayFact)[],
    range?: Readonly<{ startMs?: number; endMs?: number }>, filters?: UsageAnalyticsQueryRequest['filters']): ScopedUsageReplayContext {
    const endMs = range?.endMs;
    const beforeEnd = endMs === undefined ? rows : rows.filter(row => observedAtMs(row) < endMs);
    return selectScopedUsageReplayContext(prepareScopedUsageReplayBasis(beforeEnd), range?.startMs, filters);
}

export function resolveReleasedUsageContributions(legacy: readonly ScopedUsageEventRow[],
    linkedModern: readonly ScopedUsageEventRow[], ranks: Map<string, number>): ResolvedScopedUsageContributions {
    let cutoff = -Infinity;
    for (const row of legacy) cutoff = Math.max(cutoff, row.observedAt.getTime());
    const subjects = new Map<string, ScopedUsageEventRow[]>();
    const prefix = linkedModern.filter(row => row.observedAt.getTime() <= cutoff);
    const modernRanks = new Map(orderRuntimeObservations(prefix).map((row, index) => [row.id, index]));
    for (const row of prefix) {
        const key = usageAccountingSubjectKey(row);
        const group = subjects.get(key) ?? [];
        group.push(row);
        subjects.set(key, group);
    }
    const modern = [...subjects.values()].flatMap(rows =>
        foldScopedUsageContributions(rows, modernRanks).totalContributions);
    return foldReleasedUsageContributions(legacy, modern, ranks);
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
        : rows;
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
        const key = replayContext ? replayContext.subjects.get(row.id)! : usageAccountingSubjectKey(row);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }

    const releasedSessions = new Map<string, ScopedUsageEventRow[]>();
    for (const row of eligibleRows) {
        if (row.sessionId && row.source === 'legacy_usage_report') releasedSessions.set(row.sessionId, []);
    }
    if (releasedSessions.size) {
        for (const row of eligibleRows) {
            if (row.sessionId && row.source !== 'legacy_usage_report') releasedSessions.get(row.sessionId)?.push(row);
        }
    }

    const totalContributions: ScopedUsageContribution[] = [];
    const coverageReasons = new Set<UsageAccountingCoverageReason>();
    let reconciledEvidenceIds: Set<string> | undefined;
    for (const group of groups.values()) {
        const first = group[0]!;
        const released = first.source === 'legacy_usage_report' && first.sessionId ? releasedSessions.get(first.sessionId) : undefined;
        const resolved = released ? resolveReleasedUsageContributions(group, released, ranks) : foldScopedUsageContributions(group, ranks);
        if (resolved.reconciledEvidenceIds) {
            reconciledEvidenceIds ??= new Set();
            for (const id of resolved.reconciledEvidenceIds) reconciledEvidenceIds.add(id);
        }
        const selected = resolved.totalContributions.filter((row) => (
            (range?.startMs === undefined || row.observedAt.getTime() >= range.startMs)
            && (range?.endMs === undefined || row.observedAt.getTime() < range.endMs)
        ));
        for (const row of selected) {
            totalContributions.push(row);
            for (const reason of row.coverageReasons ?? []) coverageReasons.add(reason);
        }
        if (shouldYield()) yield;
    }

    totalContributions.sort(compareRows);
    return {
        totalContributions,
        bucketAttributions: totalContributions,
        coverageReasons: [...coverageReasons],
        ...(reconciledEvidenceIds ? { reconciledEvidenceIds } : {}),
    };
}
