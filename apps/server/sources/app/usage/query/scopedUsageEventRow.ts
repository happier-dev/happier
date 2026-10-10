import type { UsageObservationCost } from "@happier-dev/protocol";
import { createStoredReadSchema, readUsageAccountingMetadata, resolveUsageCostBasis, UsageNativeAccountingSubjectSchema, UsageObservationCostSchema } from "@happier-dev/protocol";

import type { ScopedUsageEventRow } from "./resolveScopedUsageContributions";

/**
 * The UsageEvent database fields the scoped contribution owner reads. Every
 * caller that loads usage rows for aggregation maps through
 * `toScopedUsageEventRow` so token, cost, and Team-attribution projection
 * cannot drift between personal analytics, resource analytics, and limit
 * evaluation.
 */
export type ScopedUsageEventDbRow = Readonly<{
    id: string;
    sessionId: string | null;
    observedAt: Date;
    createdAt: Date;
    agentId: string | null;
    backendMode: string | null;
    modelId: string | null;
    projectKey: string | null;
    workspaceId: string | null;
    machineId: string | null;
    source: string | null;
    scope: string;
    isCumulative: boolean;
    turnId: string | null;
    externalKey?: string | null;
    requestCount: number;
    teamCredentialResourceId: string | null;
    teamCredentialActorAccountId: string | null;
    teamCredentialExternalApiKeyId: string | null;
    teamCredentialSourceCredentialId: string | null;
    brokerMachineId: string | null;
    credentialDeliveryMode: string | null;
    metadata?: unknown;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    reportedCostUsd: number;
    estimatedCostUsd: number;
    invoiceCostUsd: number;
    billingContext: string | null;
    costSource: string | null;
    currency: string;
    costBreakdown: string | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
}>;

function readCostBreakdown(value: string | null): Record<string, number> | undefined {
    if (!value) return undefined;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        const entries = Object.entries(parsed).filter(
            (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
        );
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    } catch {
        // Malformed diagnostic metadata does not block usage views.
        return undefined;
    }
}

/**
 * Cost provenance columns are plain strings; the canonical value sets live in
 * the protocol cost contract. Null or non-canonical values degrade to the
 * honest unknown/none sentinels instead of failing a whole usage query or
 * inventing a cost fact.
 */
function readBillingContext(value: string | null): NonNullable<UsageObservationCost["billingContext"]> {
    if (value === null) return "unknown";
    const parsed = UsageObservationCostSchema.shape.billingContext.safeParse(value);
    return parsed.success && parsed.data !== undefined ? parsed.data : "unknown";
}

function readCostSource(value: string | null, cost: UsageObservationCost): NonNullable<UsageObservationCost["costSource"]> {
    // Retained rows predate provenance columns. Positive named monetary columns
    // remain witnessed facts; zero defaults cannot establish a free price.
    const source = value === null ? resolveUsageCostBasis(cost, "auto")?.source ?? "none" : value;
    const parsed = UsageObservationCostSchema.shape.costSource.safeParse(source);
    return parsed.success && parsed.data !== undefined ? parsed.data : "none";
}

export function toScopedUsageEventRow(row: ScopedUsageEventDbRow): ScopedUsageEventRow {
    let metadata: unknown = row.metadata;
    if (typeof metadata === "string") {
        try { metadata = JSON.parse(metadata); } catch { metadata = null; }
    }
    const accounting = readUsageAccountingMetadata(metadata);
    const subject = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? createStoredReadSchema(UsageNativeAccountingSubjectSchema).safeParse(Reflect.get(metadata, "accountingSubject"))
        : undefined;
    const accountingSubject = subject?.success ? subject.data : undefined;
    // This internal mapper also serves Team usage coverage. Preserve its
    // distinct evidence while normalizing only the accounting-owned fields.
    const internalMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "usageAccounting" && key !== "accountingSubject"))
        : {};
    const projectedMetadata = {
        ...internalMetadata,
        ...(accounting ? { usageAccounting: accounting } : {}),
        ...(accountingSubject ? { accountingSubject } : {}),
    };
    const cost: UsageObservationCost = {
        reportedUsd: row.reportedCostUsd,
        estimatedUsd: row.estimatedCostUsd,
        invoiceUsd: row.invoiceCostUsd,
        currency: row.currency,
    };
    return {
        id: row.id,
        sessionId: row.sessionId,
        observedAt: row.observedAt,
        createdAt: row.createdAt,
        agentId: row.agentId,
        backendMode: row.backendMode,
        modelId: row.modelId,
        projectKey: row.projectKey,
        workspaceId: row.workspaceId,
        machineId: row.machineId,
        source: row.source,
        scope: row.scope,
        isCumulative: row.isCumulative,
        turnId: row.turnId,
        externalKey: row.externalKey ?? null,
        requestCount: row.requestCount,
        teamCredentialResourceId: row.teamCredentialResourceId,
        teamCredentialActorAccountId: row.teamCredentialActorAccountId,
        teamCredentialExternalApiKeyId: row.teamCredentialExternalApiKeyId,
        teamCredentialSourceCredentialId: row.teamCredentialSourceCredentialId,
        brokerMachineId: row.brokerMachineId,
        credentialDeliveryMode: row.credentialDeliveryMode,
        metadata: Object.keys(projectedMetadata).length > 0 ? projectedMetadata : undefined,
        contextUsedTokens: row.contextUsedTokens,
        contextWindowTokens: row.contextWindowTokens,
        tokens: {
            input: row.inputTokens,
            output: row.outputTokens,
            reasoning: row.reasoningTokens,
            cacheRead: row.cacheReadTokens,
            cacheWrite: row.cacheWriteTokens,
            total: row.totalTokens,
        },
        cost: {
            ...cost,
            billingContext: readBillingContext(row.billingContext),
            costSource: readCostSource(row.costSource, cost),
            breakdown: readCostBreakdown(row.costBreakdown),
        },
    };
}
