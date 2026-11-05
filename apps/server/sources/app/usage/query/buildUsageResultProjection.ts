import type { UsageAccountingCoverageReason, UsageAnalyticsBreakdownDimension, UsageAnalyticsContribution, UsageAnalyticsCostFact, UsageAnalyticsCoverage, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { projectUsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { readUsageRequestAttribution } from "@happier-dev/protocol/usage/usageAnalyticsContracts";
import { isScopedUsageTurnDelta, readScopedUsageAccountingEvidence } from './scopedUsageEventRow';
import { resolveUsageContributionDimensionKey, resolveUsageCostBasis, resolveUsageCostFacts, resolveUsageCostMode } from "@happier-dev/protocol/usage/usageCost";
import { resolveUsageTokenCategories } from "@happier-dev/protocol/usage/usageTokenCategories";
import { ProviderConnectionIdSchema, ProviderContributionKeySchema } from "@happier-dev/protocol/providers/ids";

import { addUsageTokens, createEmptyUsageTokens } from "../usageMetrics";
import type { ScopedUsageContribution, ScopedUsageEventRow } from "./resolveScopedUsageContributions";
import { resolveUsageContributionSourceContext } from "./resolveScopedUsageContributions";
import { projectUsageCoverageEvidence, type UsageCoverageEvidence } from './projectUsageCoverageEvidence';

type RankedCoverage = UsageAnalyticsCoverage["ranked"][number];
type UsageContributionProviderAttribution = Pick<UsageAnalyticsContribution,
    'providerId' | 'providerConnectionId' | 'providerAttribution' | 'providerSource' | 'connectedAccount'>;

/** Resolve the response's witnessed source without treating current runtime dimensions as attribution. */
export function resolveUsageContributionProviderAttribution(row: ScopedUsageContribution): UsageContributionProviderAttribution {
    const { accounting } = readScopedUsageAccountingEvidence(row);
    // A counter remainder has no witnessed model-source attribution.
    const metadata = row.modelId && accounting?.path === "runtime"
        && isScopedUsageTurnDelta(row)
        && row.metadata && typeof row.metadata === "object" ? row.metadata : null;
    const provider = ProviderContributionKeySchema.safeParse(metadata && Reflect.get(metadata, "providerId"));
    const connection = ProviderConnectionIdSchema.safeParse(metadata && Reflect.get(metadata, "providerConnectionId"));
    const captured = isScopedUsageTurnDelta(row) && accounting?.path === "runtime"
        ? readUsageRequestAttribution(row.metadata) : null;
    const source = captured?.turnId === row.turnId ? captured.source : null;
    return {
        providerId: source?.kind === "provider" ? source.providerId : source ? null : provider.success ? provider.data : null,
        providerConnectionId: source?.kind === "provider" ? source.providerConnectionId : source ? null : connection.success ? connection.data : null,
        providerAttribution: source ? "known" : "unknown",
        providerSource: source?.kind ?? "unknown",
        connectedAccount: source?.kind === "native" ? source.connectedAccount : null,
    };
}

export interface UsageResultProjectionInput {
    contributions: readonly ScopedUsageContribution[];
    evidenceRows: readonly Pick<ScopedUsageEventRow,
        'source' | 'machineId' | 'metadata' | 'accountingEvidence'>[];
    coverageEvidence?: UsageCoverageEvidence;
    coverageReasons: readonly UsageAccountingCoverageReason[];
    request: UsageAnalyticsQueryRequest;
    ranked?: readonly RankedCoverage[];
    timelineTruncated?: boolean;
}

function costFactsForRow(row: ScopedUsageContribution): UsageAnalyticsCostFact[] {
    const { accounting } = readScopedUsageAccountingEvidence(row);
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

function createUsageCoverageProjector(coverageReasons: readonly UsageAccountingCoverageReason[],
    reasons: ReadonlySet<UsageAccountingCoverageReason>, sourceRows: UsageAnalyticsCoverage['sources'],
    missingDimensions: UsageAnalyticsBreakdownDimension[], historyComplete: boolean) {
    return (request: UsageAnalyticsQueryRequest, selectedRanked: readonly RankedCoverage[], timelineTruncated: boolean): UsageAnalyticsCoverage => {
        const selectedReasons = new Set(coverageReasons);
        if (timelineTruncated) selectedReasons.add('ranked_truncation');
        if (reasons.has('unknown_token_categories')) selectedReasons.add('unknown_token_categories');
        if (selectedRanked.some(entry => !entry.complete)) selectedReasons.add('ranked_truncation');
        for (const reason of reasons) selectedReasons.add(reason);
        return projectUsageAnalyticsCoverage({ reasons: [...selectedReasons], sources: sourceRows, missingDimensions,
            range: { ...request.dateRange, complete: historyComplete }, ranked: [...selectedRanked] }, request);
    };
}

/** Projects selected canonical contributions; it never reconciles or admits observations. */
export function buildUsageResultProjection(input: UsageResultProjectionInput): {
    costFacts: UsageAnalyticsCostFact[];
    coverage: UsageAnalyticsCoverage;
    contributions: NonNullable<UsageAnalyticsQueryResponse["contributions"]>;
    tokenCategories?: UsageObservationTokens;
    costPresentation?: UsageAnalyticsQueryResponse["costPresentation"];
    projectCoverage: (request: UsageAnalyticsQueryRequest, ranked: readonly RankedCoverage[], timelineTruncated: boolean) => UsageAnalyticsCoverage;
} {
    const reasons = new Set(input.coverageReasons);
    const perContributionCategories = input.contributions.map((row) => resolveUsageTokenCategories(row.tokens, readScopedUsageAccountingEvidence(row).accounting));
    if (perContributionCategories.some((categories) => categories === null)) reasons.add("unknown_token_categories");
    const tokenCategories = input.contributions.length > 0 && perContributionCategories.every((categories) => categories !== null)
        ? perContributionCategories.reduce<UsageObservationTokens>((sum, categories) => categories ? addUsageTokens(sum, categories) : sum, createEmptyUsageTokens())
        : undefined;
    const ranked = [...input.ranked ?? []];
    const dimensions = new Set<UsageAnalyticsBreakdownDimension>(["model", "machine", ...input.request.breakdowns ?? []]);
    const missingDimensions = [...dimensions].filter((dimension) => input.contributions.some((row) => !resolveUsageContributionDimensionKey(row, dimension)));
    if (missingDimensions.includes("model")) reasons.add("unattributed_model");

    const evidence = input.coverageEvidence ?? projectUsageCoverageEvidence(input.evidenceRows);
    for (const reason of evidence.reasons) reasons.add(reason);

    const groupedFacts = new Map<string, UsageAnalyticsCostFact>();
    for (const row of input.contributions) {
        for (const fact of costFactsForRow(row)) {
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
    const sourceRows = evidence.sources;
    const historyComplete = sourceRows.length > 0 && sourceRows.every((source) => source.status === "available" && source.historyComplete === true)
        && !["missing_baseline", "counter_discontinuity", "ambiguous_overlap", "incomplete_history"].some((reason) => reasons.has(reason as UsageAccountingCoverageReason));
    // Source/category admission is shared; only the requested ranking and
    // dimension badge varies between output demands over this population.
    const projectCoverage = createUsageCoverageProjector(input.coverageReasons, reasons, sourceRows, missingDimensions, historyComplete);
    const mode = resolveUsageCostMode(input.request.costMode);
    const selected = input.contributions.map((row) => resolveUsageCostBasis(row.cost, mode));
    const first = selected[0];
    const oneBasis = first && selected.every((fact) => fact !== null && fact.kind === first.kind && fact.currency === first.currency && fact.source === first.source);
    const costPresentation = oneBasis ? {
        mode, effectiveUsd: selected.reduce((sum, fact) => sum + (fact?.amountUsd ?? 0), 0), currency: first.currency, source: first.source,
    } : undefined;
    return {
        costFacts: [...groupedFacts.values()],
        coverage: projectCoverage(input.request, ranked, input.timelineTruncated === true),
        projectCoverage,
        contributions: input.contributions.map((row, index) => {
            return {
                id: row.id, eventCount: row.contributingEventIds.length, context: { usedTokens: row.contextUsedTokens, windowTokens: row.contextWindowTokens },
                observedAtMs: row.observedAt.getTime(), sessionId: row.sessionId, turnId: row.turnId,
                agentId: row.agentId, modelId: row.modelId, backendMode: row.backendMode, machineId: row.machineId ?? null, projectKey: row.projectKey,
                ...resolveUsageContributionProviderAttribution(row),
                workspaceId: row.workspaceId, source: row.source, sourceContext: resolveUsageContributionSourceContext(row), tokens: row.tokens, cost: row.cost,
                ...(perContributionCategories[index] ? { tokenCategories: perContributionCategories[index] } : {}),
            };
        }),
        ...(tokenCategories ? { tokenCategories } : {}),
        ...(costPresentation ? { costPresentation } : {}),
    };
}
