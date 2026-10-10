import type {
    UsageAccountingCoverageReason,
    UsageAnalyticsBreakdownDimension,
    UsageAnalyticsCostFact,
    UsageAnalyticsCoverage,
    UsageAnalyticsQueryRequest,
    UsageAnalyticsQueryResponse,
    UsageObservationTokens,
} from "@happier-dev/protocol";
import { readUsageAccountingMetadata } from "@happier-dev/protocol/usage/usageAnalyticsContracts";
import { resolveUsageContributionDimensionKey, resolveUsageCostBasis, resolveUsageCostFacts, resolveUsageCostMode } from "@happier-dev/protocol/usage/usageCost";
import { resolveUsageTokenCategories } from "@happier-dev/protocol/usage/usageTokenCategories";
import { ProviderConnectionIdSchema, ProviderContributionKeySchema } from "@happier-dev/protocol/providers/ids";

import { addUsageTokens, createEmptyUsageTokens } from "../usageMetrics";
import type { ScopedUsageContribution, ScopedUsageEventRow } from "./resolveScopedUsageContributions";

type RankedCoverage = UsageAnalyticsCoverage["ranked"][number];
export interface UsageResultProjectionInput {
    contributions: readonly ScopedUsageContribution[];
    evidenceRows: readonly ScopedUsageEventRow[];
    coverageReasons: readonly UsageAccountingCoverageReason[];
    request: UsageAnalyticsQueryRequest;
    ranked?: readonly RankedCoverage[];
}

function costFactsForRow(row: ScopedUsageContribution): UsageAnalyticsCostFact[] {
    const accounting = readUsageAccountingMetadata(row.metadata);
    const complete = accounting?.status === "available" && accounting.historyComplete === true && !row.coverageReasons?.length;
    const base = {
        currency: row.cost.currency,
        tokens: row.tokens,
        eventCount: 1,
        asOfMs: accounting?.asOfMs ?? row.observedAt.getTime(),
        complete,
    };
    const facts: UsageAnalyticsCostFact[] = resolveUsageCostFacts(row.cost).map((fact) => ({
        ...base, ...fact, complete: complete && (fact.kind !== "estimated" || row.modelId !== null),
    }));
    if (facts.length === 0 && row.tokens.total > 0) facts.push({ ...base, kind: "unpriced", amountUsd: null, source: "none", complete: false });
    return facts;
}

/** Projects selected canonical contributions; it never reconciles or admits observations. */
export function buildUsageResultProjection(input: UsageResultProjectionInput): {
    costFacts: UsageAnalyticsCostFact[];
    coverage: UsageAnalyticsCoverage;
    contributions: NonNullable<UsageAnalyticsQueryResponse["contributions"]>;
    tokenCategories?: UsageObservationTokens;
    costPresentation?: UsageAnalyticsQueryResponse["costPresentation"];
} {
    const reasons = new Set(input.coverageReasons);
    const perContributionCategories = input.contributions.map((row) => resolveUsageTokenCategories(row.tokens, readUsageAccountingMetadata(row.metadata)));
    if (perContributionCategories.some((categories) => categories === null)) reasons.add("unknown_token_categories");
    const tokenCategories = input.contributions.length > 0 && perContributionCategories.every((categories) => categories !== null)
        ? perContributionCategories.reduce<UsageObservationTokens>((sum, categories) => categories ? addUsageTokens(sum, categories) : sum, createEmptyUsageTokens())
        : undefined;
    const ranked = [...input.ranked ?? []];
    if (ranked.some((entry) => !entry.complete)) reasons.add("ranked_truncation");
    const dimensions = new Set<UsageAnalyticsBreakdownDimension>(["model", "machine", ...input.request.breakdowns ?? []]);
    const missingDimensions = [...dimensions].filter((dimension) => input.contributions.some((row) => !resolveUsageContributionDimensionKey(row, dimension)));
    if (missingDimensions.includes("model")) reasons.add("unattributed_model");

    const sources = new Map<string, UsageAnalyticsCoverage["sources"][number]>();
    for (const row of input.evidenceRows) {
        const accounting = readUsageAccountingMetadata(row.metadata);
        const source = row.source ?? "unknown";
        const path = accounting?.path ?? "unknown";
        const status = accounting?.status ?? "unknown";
        // Preserve each observed producer state, rather than replacing pending/error with available.
        const key = JSON.stringify([source, path, status]);
        const previous = sources.get(key);
        const asOfMs = accounting?.asOfMs;
        sources.set(key, {
            source, path, status,
            eventCount: (previous?.eventCount ?? 0) + 1,
            ...(asOfMs !== undefined || previous?.asOfMs !== undefined ? { asOfMs: Math.max(asOfMs ?? 0, previous?.asOfMs ?? 0) } : {}),
            ...(accounting?.historyComplete !== undefined || previous?.historyComplete !== undefined ? { historyComplete: accounting?.historyComplete === true && (!previous || previous.historyComplete === true) } : {}),
        });
        if (path === "unknown" || status === "unknown" || source === "unknown") reasons.add("unknown_source");
        if (accounting?.historyComplete !== true || status !== "available") reasons.add("incomplete_history");
    }
    if (sources.size === 0) reasons.add("unknown_source");

    const groupedFacts = new Map<string, UsageAnalyticsCostFact>();
    const perContributionFacts = input.contributions.map(costFactsForRow);
    for (const facts of perContributionFacts) {
        for (const fact of facts) {
            if (fact.kind === "unpriced") reasons.add("unpriced_tokens");
            const key = JSON.stringify([fact.kind, fact.currency, fact.source]);
            const previous = groupedFacts.get(key);
            groupedFacts.set(key, previous ? {
                ...fact,
                amountUsd: fact.amountUsd === null || previous.amountUsd === null ? null : fact.amountUsd + previous.amountUsd,
                tokens: addUsageTokens(previous.tokens, fact.tokens),
                eventCount: previous.eventCount + fact.eventCount,
                asOfMs: Math.max(previous.asOfMs, fact.asOfMs),
                complete: previous.complete && fact.complete,
            } : fact);
        }
    }
    const sourceRows = [...sources.values()];
    const historyComplete = sourceRows.length > 0 && sourceRows.every((source) => source.status === "available" && source.historyComplete === true)
        && !["missing_baseline", "counter_discontinuity", "ambiguous_overlap"].some((reason) => reasons.has(reason as UsageAccountingCoverageReason));
    const status = sourceRows.length === 0 || sourceRows.every((source) => source.status === "unknown") ? "unknown"
        : reasons.size > 0 || missingDimensions.length > 0 ? "partial" : "complete";
    const mode = resolveUsageCostMode(input.request.costMode);
    const selected = input.contributions.map((row) => resolveUsageCostBasis(row.cost, mode));
    const first = selected[0];
    const oneBasis = first && selected.every((fact) => fact !== null && fact.kind === first.kind && fact.currency === first.currency && fact.source === first.source);
    const costPresentation = oneBasis ? {
        mode, effectiveUsd: selected.reduce((sum, fact) => sum + (fact?.amountUsd ?? 0), 0), currency: first.currency, source: first.source,
    } : undefined;
    return {
        costFacts: [...groupedFacts.values()],
        coverage: {
            status, reasons: [...reasons], sources: sourceRows, missingDimensions,
            range: { ...input.request.dateRange, complete: historyComplete }, ranked,
        },
        contributions: input.contributions.map((row, index) => {
            // A counter remainder has no witnessed model-source attribution.
            const metadata = row.modelId && readUsageAccountingMetadata(row.metadata)?.path === "runtime"
                && row.scope === "turn_delta" && !row.isCumulative
                && row.metadata && typeof row.metadata === "object" ? row.metadata : null;
            const provider = ProviderContributionKeySchema.safeParse(metadata && Reflect.get(metadata, "providerId"));
            const connection = ProviderConnectionIdSchema.safeParse(metadata && Reflect.get(metadata, "providerConnectionId"));
            return {
                id: row.id, observedAtMs: row.observedAt.getTime(), sessionId: row.sessionId, turnId: row.turnId,
                agentId: row.agentId, modelId: row.modelId, backendMode: row.backendMode, machineId: row.machineId ?? null, projectKey: row.projectKey,
                providerId: provider.success ? provider.data : null,
                providerConnectionId: connection.success ? connection.data : null,
                // Runtime dimensions are read from current Session metadata after
                // transcript admission; they do not witness this response's source.
                providerAttribution: "unknown" as const,
                workspaceId: row.workspaceId, source: row.source, tokens: row.tokens, cost: row.cost,
                ...(perContributionCategories[index] ? { tokenCategories: perContributionCategories[index] } : {}),
            };
        }),
        ...(tokenCategories ? { tokenCategories } : {}),
        ...(costPresentation ? { costPresentation } : {}),
    };
}
