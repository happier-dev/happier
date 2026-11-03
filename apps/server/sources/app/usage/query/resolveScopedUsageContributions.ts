import type { UsageAccountingCoverageReason, UsageObservationCost, UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageAnalyticsSourceContext } from "@happier-dev/protocol/usage/usageAnalyticsContracts";
import { readScopedUsageAccountingEvidence, type ScopedUsageAccountingEvidence } from './scopedUsageEventRow';

import { addUsageCost, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens, subtractUsageCost, subtractUsageTokens, usageHasAnyValue } from "../usageMetrics";

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

export function usageAccountingSubjectKey(row: ScopedUsageEventRow): string {
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

function compareChronologically(left: ScopedUsageEventRow, right: ScopedUsageEventRow): number {
    const observedDifference = left.observedAt.getTime() - right.observedAt.getTime();
    if (observedDifference !== 0) return observedDifference;
    const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDifference !== 0) return createdDifference;
    return left.id.localeCompare(right.id);
}

function orderRuntimeObservations(rows: readonly ScopedUsageEventRow[]): ScopedUsageEventRow[] {
    const ordered = [...rows].sort(compareChronologically);
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (end < ordered.length && ordered[end]!.observedAt.getTime() === ordered[start]!.observedAt.getTime()) end++;
        const streams = new Map<string, { slots: number[]; rows: Array<{ row: ScopedUsageEventRow; sequence: number }> }>();
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

function asContribution(
    row: ScopedUsageEventRow,
    tokens: UsageObservationTokens = row.tokens,
    cost: UsageObservationCost = row.cost,
    contributingEventIds: readonly string[] = [row.id],
): ScopedUsageContribution {
    return {
        ...row,
        tokens,
        cost,
        contributingEventIds,
    };
}

function resolveGroup(rows: readonly ScopedUsageEventRow[], ranks: Map<string, number>): ResolvedScopedUsageContributions {
    const compareRows = (left: ScopedUsageEventRow, right: ScopedUsageEventRow): number =>
        ranks.get(left.id)! - ranks.get(right.id)! || left.id.localeCompare(right.id);
    const chronological = [...rows].sort(compareRows);
    const reasons = new Set<UsageAccountingCoverageReason>();
    const inferences = new Map<string, ScopedUsageEventRow>();
    const uncorrelated: ScopedUsageEventRow[] = [];
    const contextOnly: ScopedUsageEventRow[] = [];
    for (const row of chronological) {
        if ((row.isCumulative || row.scope !== "turn_delta")
            && (row.contextUsedTokens != null || row.contextWindowTokens != null)
            && !usageHasAnyValue(row.tokens, row.cost)) {
            // Context occupancy is a presentation fact, not a cumulative inference counter.
            contextOnly.push(row);
            continue;
        }
        const identity = row.accountingEvidence?.accounting?.inferenceId;
        if (row.scope !== "turn_delta" || row.isCumulative || !identity) {
            uncorrelated.push(row);
            continue;
        }
        const previous = inferences.get(identity);
        if (previous && (previous.tokens.total !== row.tokens.total || previous.modelId !== row.modelId)) {
            reasons.add("ambiguous_overlap");
        }
        // Explicit replay identity is the only cross-source inference witness.
        // Prefer the live observation when both paths witnessed the same request.
        const previousPath = previous?.accountingEvidence?.accounting?.path;
        const path = row.accountingEvidence?.accounting?.path;
        const previousOrder = previous?.accountingEvidence?.accounting?.runtimeEventOrder;
        const order = row.accountingEvidence?.accounting?.runtimeEventOrder;
        const sameRuntime = previousPath === 'runtime' && path === 'runtime' && previousOrder && order
            && previousOrder.runtimeIncarnationId === order.runtimeIncarnationId;
        if (!previous || previousPath !== "runtime" || (path === "runtime"
            && (!sameRuntime || order.sequence < previousOrder.sequence))) inferences.set(identity, row);
    }
    const ordered = [...uncorrelated, ...inferences.values()].sort(compareRows);
    const latestFinal = ordered.filter((row) => row.scope === "session_final").at(-1);
    const deltas = ordered.filter((row) => row.scope === "turn_delta" && !row.isCumulative);
    const snapshots = ordered.filter((row) => (row.isCumulative || row.scope !== "turn_delta")
        && (!latestFinal || compareRows(row, latestFinal) <= 0));
    const contributions: ScopedUsageContribution[] = [];
    let previous: ScopedUsageEventRow | undefined;
    let previousTokenSnapshot: ScopedUsageEventRow | undefined;
    let pendingTokenDeltas = createEmptyUsageTokens();
    let deltaIndex = 0;
    let reportedCoverageStartIndex = 0;
    for (const snapshot of snapshots) {
        const intervalStartIndex = contributions.length;
        let intervalTokens = createEmptyUsageTokens();
        let intervalCost = createEmptyUsageCost(snapshot.cost.currency);
        while (deltaIndex < deltas.length && compareRows(deltas[deltaIndex]!, snapshot) <= 0) {
            const delta = deltas[deltaIndex++]!;
            contributions.push(asContribution(delta));
            intervalTokens = addUsageTokens(intervalTokens, delta.tokens);
            intervalCost = addUsageCost(intervalCost, delta.cost);
        }
        // A paid context observation advances money without asserting an inference-token total.
        const hasTokenSnapshot = (snapshot.contextUsedTokens == null && snapshot.contextWindowTokens == null)
            || usageHasAnyValue(snapshot.tokens, createEmptyUsageCost(snapshot.cost.currency));
        pendingTokenDeltas = addUsageTokens(pendingTokenDeltas, intervalTokens);
        const epoch = snapshot.accountingEvidence?.accounting?.counterEpoch;
        const previousEpoch = previous?.accountingEvidence?.accounting?.counterEpoch;
        const witnessedReset = previous && epoch !== undefined && previousEpoch !== undefined && epoch !== previousEpoch;
        const tokenReset = hasTokenSnapshot && previousTokenSnapshot
            && snapshot.tokens.total < previousTokenSnapshot.tokens.total;
        const reset = previous && (witnessedReset || tokenReset);
        if (reset) reportedCoverageStartIndex = intervalStartIndex;
        if (reset && !witnessedReset) reasons.add("counter_discontinuity");
        const baselineTokens = previousTokenSnapshot && !reset ? previousTokenSnapshot.tokens : createEmptyUsageTokens();
        const baselineCost = previous && !reset ? previous.cost : createEmptyUsageCost(snapshot.cost.currency);
        const missingBaseline = hasTokenSnapshot && !previousTokenSnapshot && snapshot.tokens.total > pendingTokenDeltas.total
            && snapshot.accountingEvidence?.accounting?.historyComplete !== true;
        const increaseTokens = subtractUsageTokens(snapshot.tokens, baselineTokens);
        if (hasTokenSnapshot && increaseTokens.total < pendingTokenDeltas.total) reasons.add("ambiguous_overlap");
        const tokens = hasTokenSnapshot ? subtractUsageTokens(increaseTokens, pendingTokenDeltas) : createEmptyUsageTokens();
        const cost = subtractUsageCost(subtractUsageCost(snapshot.cost, baselineCost), intervalCost);
        const hasReportedTotal = snapshot.cost.reportedUsd > 0 || snapshot.cost.costSource === 'provider_reported'
            || snapshot.cost.costSource === 'provider_reported_api_equivalent';
        const coveredIds: string[] = [];
        const hasResidual = usageHasAnyValue(tokens, { ...cost, reportedUsd: 0, invoiceUsd: 0 });
        const totalId = hasResidual ? `${snapshot.id}:reported` : snapshot.id;
        ranks.set(totalId, ranks.get(snapshot.id)!);
        if (hasReportedTotal) {
            // The counter's reported charge covers this epoch, not just its residual tokens.
            // Earlier reported deltas already telescope in their own basis. Retain unlike
            // raw/API facts, but never add their fallback charge to the whole reported total.
            for (let index = reportedCoverageStartIndex; index < contributions.length; index++) {
                const contribution = contributions[index]!;
                const reported = contribution.cost.reportedUsd > 0 || contribution.cost.costSource === 'provider_reported'
                    || contribution.cost.costSource === 'provider_reported_api_equivalent';
                if (!reported && contribution.cost.currency === snapshot.cost.currency) {
                    coveredIds.push(contribution.id);
                    contributions[index] = { ...contribution, cost: { ...contribution.cost, reportedTotalId: totalId } };
                }
            }
        }
        const coverageReasons: UsageAccountingCoverageReason[] = missingBaseline ? ["missing_baseline"] : [];
        if (coveredIds.length > 0) {
            // Money is a whole-interval fact. Keep it separate from token residuals;
            // the cost owner admits selection only with every covered contribution.
            if (hasResidual) {
                coveredIds.push(snapshot.id);
                contributions.push({ ...asContribution({ ...snapshot, modelId: null, turnId: null }, tokens,
                    { ...cost, reportedUsd: 0, invoiceUsd: 0,
                        costSource: cost.estimatedUsd > 0 ? 'pricing_estimate' : 'none', reportedTotalId: totalId }), coverageReasons });
            }
            contributions.push({ ...asContribution({ ...snapshot, id: totalId, modelId: null, turnId: null }, createEmptyUsageTokens(),
                { ...cost, estimatedUsd: 0, reportedTotalContributionIds: coveredIds }, hasResidual ? [] : [snapshot.id]), coverageReasons });
        } else if (usageHasAnyValue(tokens, cost)) {
            // A session counter establishes amount, not an inference's model,
            // turn or exact earlier activity time. Retain that missing evidence.
            contributions.push({
                ...asContribution({ ...snapshot, modelId: null, turnId: null }, tokens, cost),
                coverageReasons,
            });
        }
        if (hasReportedTotal) reportedCoverageStartIndex = contributions.length;
        if (hasTokenSnapshot || witnessedReset) {
            previousTokenSnapshot = hasTokenSnapshot ? snapshot : undefined;
            pendingTokenDeltas = createEmptyUsageTokens();
        }
        previous = snapshot;
    }
    for (; deltaIndex < deltas.length; deltaIndex++) contributions.push(asContribution(deltas[deltaIndex]!));
    for (const context of contextOnly) contributions.push(asContribution(context));
    const uncorrelatedSources = new Set(deltas.filter((row) => !row.accountingEvidence?.accounting?.inferenceId).map((row) => row.source));
    if (uncorrelatedSources.size > 1) reasons.add("ambiguous_overlap");
    const resolved = contributions.sort(compareRows).map((row) => ({ ...row, coverageReasons: [...new Set([...reasons, ...row.coverageReasons ?? []])] }));
    return { totalContributions: resolved, bucketAttributions: resolved, coverageReasons: [...new Set(resolved.flatMap((row) => row.coverageReasons ?? []))] };
}

export function resolveScopedUsageContributions(
    rows: readonly ScopedUsageEventRow[],
    range?: Readonly<{ startMs?: number; endMs?: number }>,
): ResolvedScopedUsageContributions {
    // DB rows arrive projected; in-memory callers share the same boundary once.
    rows = rows.map((row) => row.accountingEvidence ? row : { ...row, accountingEvidence: readScopedUsageAccountingEvidence(row) });
    const sessionsWithNativeUsage = new Set(
        rows.flatMap((row) => (
            row.sessionId && row.source !== "legacy_usage_report" ? [row.sessionId] : []
        )),
    );
    const eligibleRows = rows.filter((row) => (
        row.source !== "legacy_usage_report"
        || !row.sessionId
        || !sessionsWithNativeUsage.has(row.sessionId)
    ));
    // Reorder only the existing slots of one witnessed runtime at an equal
    // source instant. Pairwise same-runtime/else-created comparisons can cycle
    // across mixed streams; these fixed ranks govern reconciliation and output.
    const ranks = new Map(orderRuntimeObservations(eligibleRows).map((row, index) => [row.id, index]));
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
    }

    return {
        totalContributions: totalContributions.sort(compareRows),
        bucketAttributions: bucketAttributions.sort(compareRows),
        coverageReasons: [...coverageReasons],
    };
}
