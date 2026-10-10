import type {
    UsageAccountingCoverageReason,
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";
import { createStoredReadSchema, UsageNativeAccountingSubjectSchema, readUsageAccountingMetadata } from "@happier-dev/protocol";

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

const nativeSubjectReadSchema = createStoredReadSchema(UsageNativeAccountingSubjectSchema);

export function usageAccountingSubjectKey(row: ScopedUsageEventRow): string {
    // A witnessed native subject owns accounting across live and collector
    // rows; the real Session remains attribution on the selected contribution.
    const metadata = row.metadata;
    const subject = nativeSubjectReadSchema.safeParse(metadata && typeof metadata === "object"
        ? Reflect.get(metadata, "accountingSubject") : undefined);
    if (subject.success) {
        const native = subject.data;
        return JSON.stringify(["native", native.machineId, native.agent.pluginId, native.agent.localId,
            native.sourceRootKey, native.nativeSessionKey]);
    }
    if (row.sessionId) return JSON.stringify(["session", row.sessionId, row.agentId]);
    const nativeSessionId = readUsageAccountingMetadata(row.metadata)?.nativeSessionId;
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

function resolveGroup(rows: readonly ScopedUsageEventRow[]): ResolvedScopedUsageContributions {
    const reasons = new Set<UsageAccountingCoverageReason>();
    const inferences = new Map<string, ScopedUsageEventRow>();
    const uncorrelated: ScopedUsageEventRow[] = [];
    for (const row of [...rows].sort(compareChronologically)) {
        const identity = readUsageAccountingMetadata(row.metadata)?.inferenceId;
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
        const previousPath = previous && readUsageAccountingMetadata(previous.metadata)?.path;
        const path = readUsageAccountingMetadata(row.metadata)?.path;
        if (!previous || previousPath !== "runtime" || path === "runtime") inferences.set(identity, row);
    }
    const ordered = [...uncorrelated, ...inferences.values()].sort(compareChronologically);
    const latestFinal = ordered.filter((row) => row.scope === "session_final").at(-1);
    const deltas = ordered.filter((row) => row.scope === "turn_delta" && !row.isCumulative);
    const snapshots = ordered.filter((row) => (row.isCumulative || row.scope !== "turn_delta")
        && (!latestFinal || compareChronologically(row, latestFinal) <= 0));
    const contributions: ScopedUsageContribution[] = [];
    let previous: ScopedUsageEventRow | undefined;
    let deltaIndex = 0;
    for (const snapshot of snapshots) {
        let intervalTokens = createEmptyUsageTokens();
        let intervalCost = createEmptyUsageCost(snapshot.cost.currency);
        while (deltaIndex < deltas.length && compareChronologically(deltas[deltaIndex]!, snapshot) <= 0) {
            const delta = deltas[deltaIndex++]!;
            contributions.push(asContribution(delta));
            intervalTokens = addUsageTokens(intervalTokens, delta.tokens);
            intervalCost = addUsageCost(intervalCost, delta.cost);
        }
        const epoch = readUsageAccountingMetadata(snapshot.metadata)?.counterEpoch;
        const previousEpoch = previous && readUsageAccountingMetadata(previous.metadata)?.counterEpoch;
        const witnessedReset = previous && epoch !== undefined && previousEpoch !== undefined && epoch !== previousEpoch;
        const reset = previous && (witnessedReset || snapshot.tokens.total < previous.tokens.total);
        if (reset && !witnessedReset) reasons.add("counter_discontinuity");
        const baselineTokens = previous && !reset ? previous.tokens : createEmptyUsageTokens();
        const baselineCost = previous && !reset ? previous.cost : createEmptyUsageCost(snapshot.cost.currency);
        const missingBaseline = !previous && snapshot.tokens.total > intervalTokens.total
            && readUsageAccountingMetadata(snapshot.metadata)?.historyComplete !== true;
        const increaseTokens = subtractUsageTokens(snapshot.tokens, baselineTokens);
        if (increaseTokens.total < intervalTokens.total) reasons.add("ambiguous_overlap");
        const tokens = subtractUsageTokens(increaseTokens, intervalTokens);
        const cost = subtractUsageCost(subtractUsageCost(snapshot.cost, baselineCost), intervalCost);
        if (usageHasAnyValue(tokens, cost)) {
            // A session counter establishes amount, not an inference's model,
            // turn or exact earlier activity time. Retain that missing evidence.
            contributions.push({
                ...asContribution({ ...snapshot, modelId: null, turnId: null }, tokens, cost),
                coverageReasons: missingBaseline ? ["missing_baseline"] : [],
            });
        }
        previous = snapshot;
    }
    for (; deltaIndex < deltas.length; deltaIndex++) contributions.push(asContribution(deltas[deltaIndex]!));
    const uncorrelatedSources = new Set(deltas.filter((row) => !readUsageAccountingMetadata(row.metadata)?.inferenceId).map((row) => row.source));
    if (uncorrelatedSources.size > 1) reasons.add("ambiguous_overlap");
    const resolved = contributions.sort(compareChronologically).map((row) => ({ ...row, coverageReasons: [...new Set([...reasons, ...row.coverageReasons ?? []])] }));
    return { totalContributions: resolved, bucketAttributions: resolved, coverageReasons: [...new Set(resolved.flatMap((row) => row.coverageReasons ?? []))] };
}

export function resolveScopedUsageContributions(
    rows: readonly ScopedUsageEventRow[],
    range?: Readonly<{ startMs?: number; endMs?: number }>,
): ResolvedScopedUsageContributions {
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
        const resolved = resolveGroup(group);
        const selected = resolved.totalContributions.filter((row) => (
            (range?.startMs === undefined || row.observedAt.getTime() >= range.startMs)
            && (range?.endMs === undefined || row.observedAt.getTime() <= range.endMs)
        ));
        totalContributions.push(...selected);
        bucketAttributions.push(...selected);
        for (const row of selected) for (const reason of row.coverageReasons ?? []) coverageReasons.add(reason);
    }

    return {
        totalContributions: totalContributions.sort(compareChronologically),
        bucketAttributions: bucketAttributions.sort(compareChronologically),
        coverageReasons: [...coverageReasons],
    };
}
