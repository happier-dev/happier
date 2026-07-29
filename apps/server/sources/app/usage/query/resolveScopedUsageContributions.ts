import type {
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";

import { subtractUsageCost, subtractUsageTokens } from "../usageMetrics";
import { resolveEffectiveUsageCostUsd } from "./resolveUsageCostMode";

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
    source: string | null;
    scope: string;
    isCumulative: boolean;
    turnId: string | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    tokens: UsageObservationTokens;
    cost: UsageObservationCost;
}

export interface ScopedUsageContribution extends ScopedUsageEventRow {
    contributingEventIds: readonly string[];
}

export interface ResolvedScopedUsageContributions {
    totalContributions: ScopedUsageContribution[];
    bucketAttributions: ScopedUsageContribution[];
}

function buildGroupKey(row: ScopedUsageEventRow): string {
    return row.sessionId && row.agentId
        ? JSON.stringify([row.sessionId, row.agentId])
        : JSON.stringify([row.sessionId, row.agentId, row.source]);
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

function buildSnapshotAttributions(rows: readonly ScopedUsageEventRow[]): ScopedUsageContribution[] {
    let previous: ScopedUsageEventRow | null = null;
    let contributions: ScopedUsageContribution[] = [];
    for (const row of rows) {
        if (!previous) {
            contributions.push(asContribution(row));
            previous = row;
            continue;
        }

        const countersReset = row.tokens.total < previous.tokens.total
            || resolveEffectiveUsageCostUsd(row.cost, "auto") < resolveEffectiveUsageCostUsd(previous.cost, "auto");
        if (countersReset) {
            contributions = [asContribution(row)];
        } else {
            const cost = subtractUsageCost(row.cost, previous.cost);
            contributions.push(asContribution(
                row,
                subtractUsageTokens(row.tokens, previous.tokens),
                {
                    ...cost,
                    effectiveUsd: resolveEffectiveUsageCostUsd(row.cost, "auto")
                        - resolveEffectiveUsageCostUsd(previous.cost, "auto"),
                },
            ));
        }
        previous = row;
    }
    return contributions;
}

function resolveGroup(rows: readonly ScopedUsageEventRow[]): ResolvedScopedUsageContributions {
    const ordered = [...rows].sort(compareChronologically);
    const finalRows = ordered.filter((row) => row.scope === "session_final");
    const cumulativeRows = ordered.filter((row) => (
        row.scope === "session_cumulative"
        || (row.isCumulative && row.scope !== "session_final")
    ));

    if (finalRows.length > 0) {
        const latest = finalRows.at(-1)!;
        const snapshotRowsThroughFinal = ordered.filter((row) => (
            compareChronologically(row, latest) <= 0
            && (
                row.scope === "session_final"
                || row.scope === "session_cumulative"
                || row.isCumulative
            )
        ));
        return {
            totalContributions: [asContribution(latest, latest.tokens, latest.cost, ordered.map((row) => row.id))],
            bucketAttributions: buildSnapshotAttributions(snapshotRowsThroughFinal),
        };
    }

    if (cumulativeRows.length > 0) {
        const latest = cumulativeRows.at(-1)!;
        return {
            totalContributions: [asContribution(latest, latest.tokens, latest.cost, ordered.map((row) => row.id))],
            bucketAttributions: buildSnapshotAttributions(cumulativeRows),
        };
    }

    return {
        totalContributions: ordered.map((row) => asContribution(row)),
        bucketAttributions: ordered.map((row) => asContribution(row)),
    };
}

export function resolveScopedUsageContributions(
    rows: readonly ScopedUsageEventRow[],
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
        const key = buildGroupKey(row);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }

    const totalContributions: ScopedUsageContribution[] = [];
    const bucketAttributions: ScopedUsageContribution[] = [];
    for (const group of groups.values()) {
        const resolved = resolveGroup(group);
        totalContributions.push(...resolved.totalContributions);
        bucketAttributions.push(...resolved.bucketAttributions);
    }

    return {
        totalContributions: totalContributions.sort(compareChronologically),
        bucketAttributions: bucketAttributions.sort(compareChronologically),
    };
}
