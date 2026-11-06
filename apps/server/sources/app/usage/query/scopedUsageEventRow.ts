import type { UsageAccountingMetadata, UsageNativeAccountingSubject, UsageObservationCost } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readUsageAccountingMetadata, readUsageRequestAttribution, UsageNativeAccountingSubjectSchema, UsageObservationCostSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCostFacts';

import type { ScopedUsageEventRow } from "./resolveScopedUsageContributions";

export interface ScopedUsageAccountingEvidence {
    accounting: UsageAccountingMetadata | null;
    subject: UsageNativeAccountingSubject | null;
}

export function isScopedUsageTurnDelta(row: Pick<ScopedUsageEventRow, 'scope' | 'isCumulative'>): boolean {
    return row.scope === 'turn_delta' && !row.isCumulative;
}

const nativeSubjectReadSchema = createStoredReadSchema(UsageNativeAccountingSubjectSchema);

/** Exclude known Team usage; unknown ownership keeps ordinary Usage reconciliation. */
export function isPublicEligibleUsageRow(row: Pick<ScopedUsageEventRow, 'metadata' | 'teamCredentialResourceId'
    | 'teamCredentialActorAccountId' | 'teamCredentialExternalApiKeyId' | 'teamCredentialSourceCredentialId'>): boolean {
    if (row.teamCredentialResourceId || row.teamCredentialActorAccountId
        || row.teamCredentialExternalApiKeyId || row.teamCredentialSourceCredentialId) return false;
    const attribution = readUsageRequestAttribution(row.metadata);
    return !(attribution?.source.kind === 'native' && attribution.source.accountScope === 'workspace');
}

/** Keep parsed evidence on the row, including the neutral parser's normalized JSON snapshots. */
export function readScopedUsageAccountingEvidence(
    row: Pick<ScopedUsageEventRow, "metadata" | "accountingEvidence">,
): ScopedUsageAccountingEvidence {
    if (row.accountingEvidence) return row.accountingEvidence;
    const metadata = parseUsageEventMetadata(row.metadata);
    const subject = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? nativeSubjectReadSchema.safeParse(Reflect.get(metadata, "accountingSubject"))
        : undefined;
    return {
        accounting: readUsageAccountingMetadata(metadata),
        subject: subject?.success ? subject.data : null,
    };
}

function parseUsageEventMetadata(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
}

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
    /** Already admitted facts on a captured row shared by one accounting batch. */
    accountingEvidence?: ScopedUsageAccountingEvidence;
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

type UsageEvidenceField = 'id' | 'sessionId' | 'observedAt' | 'createdAt' | 'agentId' | 'backendMode'
    | 'modelId' | 'projectKey' | 'workspaceId' | 'machineId' | 'source' | 'metadata' | 'scope' | 'isCumulative'
    | 'teamCredentialResourceId' | 'teamCredentialActorAccountId' | 'teamCredentialExternalApiKeyId'
    | 'teamCredentialSourceCredentialId';

export type ScopedUsageEvidenceDbRow = Pick<ScopedUsageEventDbRow, UsageEvidenceField | 'accountingEvidence'>;
export type ScopedUsageEvidenceRow = Pick<ScopedUsageEventRow, UsageEvidenceField>
    & { accountingEvidence: ScopedUsageAccountingEvidence };

function normalizeScopedUsageMetadata(value: unknown, admittedEvidence?: ScopedUsageAccountingEvidence) {
    const metadata = parseUsageEventMetadata(value);
    const accountingEvidence = admittedEvidence ?? readScopedUsageAccountingEvidence({ metadata });
    const { accounting, subject: accountingSubject } = accountingEvidence;
    // Team coverage also consumes metadata outside the accounting projection.
    const internalMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'usageAccounting' && key !== 'accountingSubject'))
        : {};
    const projectedMetadata = {
        ...internalMetadata,
        ...(accounting ? { usageAccounting: accounting } : {}),
        ...(accountingSubject ? { accountingSubject } : {}),
    };
    return { metadata: Object.keys(projectedMetadata).length > 0 ? projectedMetadata : undefined, accountingEvidence };
}

/** Normalize historical identity and coverage without token or monetary row bodies. */
export function toScopedUsageEvidenceRow<Row extends ScopedUsageEvidenceDbRow>(row: Row):
    Omit<Row, 'metadata' | 'accountingEvidence'> & Pick<ScopedUsageEvidenceRow, 'metadata' | 'accountingEvidence'> {
    return { ...row, ...normalizeScopedUsageMetadata(row.metadata, row.accountingEvidence) };
}

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
    return toScopedUsageEventRowWithEvidence(row);
}

/** Captured thin evidence already owns metadata normalization for this row. */
export function toScopedUsageEventRowWithEvidence(row: ScopedUsageEventDbRow, evidence?: ScopedUsageEvidenceRow): ScopedUsageEventRow {
    const { metadata, accountingEvidence } = evidence ?? normalizeScopedUsageMetadata(row.metadata, row.accountingEvidence);
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
        metadata,
        accountingEvidence,
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
