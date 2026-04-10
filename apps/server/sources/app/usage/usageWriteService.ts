import type {
    UsageEventIngestRequest,
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";
import { Prisma } from "@prisma/client";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import {
    normalizeLegacyUsageCost,
    normalizeLegacyUsageTokens,
    subtractUsageCost,
    subtractUsageTokens,
    usageHasAnyValue,
} from "./usageMetrics";

export type LegacyUsageReportInput = Readonly<{
    accountId: string;
    key: string;
    sessionId: string | null;
    tokens: Record<string, number> & { total: number };
    cost: Record<string, number> & { total: number };
}>;

export type RecordLegacyUsageReportResult =
    | {
        ok: true;
        report: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
        };
        usageEventId: string | null;
      }
    | {
        ok: false;
        error: 'invalid-params' | 'session-not-found';
      };

export type RecordUsageEventResult =
    | {
        ok: true;
        event: {
            id: string;
            createdAt: Date;
        };
      }
    | {
        ok: false;
        error: 'session-not-found';
      };

function toUsageEventCreateInput(
    accountId: string,
    request: UsageEventIngestRequest,
): Prisma.UsageEventUncheckedCreateInput {
    return {
        accountId,
        sessionId: request.sessionId || null,
        observedAt: new Date(request.observedAt),
        providerId: request.providerId,
        backendMode: request.backendMode ?? null,
        modelId: request.modelId ?? null,
        projectKey: request.projectKey ?? null,
        workspaceId: request.workspaceId ?? null,
        machineId: request.machineId ?? null,
        source: request.source,
        scope: request.scope,
        externalKey: request.externalKey ?? null,
        turnId: request.turnId ?? null,
        isCumulative: request.isCumulative,
        inputTokens: request.tokens.input,
        outputTokens: request.tokens.output,
        reasoningTokens: request.tokens.reasoning,
        cacheReadTokens: request.tokens.cacheRead,
        cacheWriteTokens: request.tokens.cacheWrite,
        totalTokens: request.tokens.total,
        reportedCostUsd: request.cost.reportedUsd,
        estimatedCostUsd: request.cost.estimatedUsd,
        invoiceCostUsd: request.cost.invoiceUsd ?? 0,
        billingContext: request.cost.billingContext ?? null,
        costSource: request.cost.costSource ?? null,
        currency: request.cost.currency,
        contextUsedTokens: request.context?.usedTokens ?? null,
        contextWindowTokens: request.context?.windowTokens ?? null,
        metadata: request.metadata ?? null,
    };
}

async function ensureSessionOwnedByAccount(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string }>,
): Promise<boolean> {
    const session = await tx.session.findFirst({
        where: {
            id: params.sessionId,
            accountId: params.accountId,
        },
        select: { id: true },
    });
    return Boolean(session);
}

function buildLegacyDeltaRequest(
    params: Readonly<{
        key: string;
        sessionId: string | null;
        nextUsage: PrismaJson.UsageReportData;
        previousUsage: PrismaJson.UsageReportData | null;
        observedAtMs: number;
    }>,
): UsageEventIngestRequest | null {
    const nextTokens = normalizeLegacyUsageTokens(params.nextUsage.tokens);
    const previousTokens = normalizeLegacyUsageTokens(params.previousUsage?.tokens ?? {});

    const nextCost = normalizeLegacyUsageCost(params.nextUsage.cost);
    const previousCost = normalizeLegacyUsageCost(params.previousUsage?.cost ?? {});
    const treatAsReset = nextTokens.total < previousTokens.total || nextCost.reportedUsd < previousCost.reportedUsd;
    const deltaTokens = treatAsReset ? nextTokens : subtractUsageTokens(nextTokens, previousTokens);
    const deltaCost = treatAsReset ? nextCost : subtractUsageCost(nextCost, previousCost);

    if (!usageHasAnyValue(deltaTokens, deltaCost)) {
        return null;
    }

    return {
        sessionId: params.sessionId ?? '',
        observedAt: params.observedAtMs,
        providerId: 'legacy',
        backendMode: null,
        modelId: null,
        projectKey: null,
        workspaceId: null,
        machineId: null,
        source: 'legacy_usage_report',
        scope: 'session_cumulative',
        externalKey: params.sessionId ? `${params.key}:${params.observedAtMs}` : null,
        turnId: null,
        isCumulative: false,
        tokens: deltaTokens,
        cost: deltaCost,
        context: undefined,
        metadata: {
            legacyKey: params.key,
        },
    };
}

function toLegacyUsageEphemeralTokens(tokens: UsageObservationTokens): Record<string, number> {
    return {
        total: tokens.total,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
    };
}

function toLegacyUsageEphemeralCost(cost: UsageObservationCost): Record<string, number> {
    return {
        total: cost.reportedUsd,
        reportedUsd: cost.reportedUsd,
        estimatedUsd: cost.estimatedUsd,
        invoiceUsd: cost.invoiceUsd ?? 0,
    };
}

export async function recordUsageEvent(
    accountId: string,
    request: UsageEventIngestRequest,
): Promise<RecordUsageEventResult> {
    return await inTx(async (tx) => {
        if (!(await ensureSessionOwnedByAccount(tx, { accountId, sessionId: request.sessionId }))) {
            return { ok: false, error: 'session-not-found' };
        }

        if (request.externalKey) {
            const existing = await tx.usageEvent.findFirst({
                where: {
                    accountId,
                    sessionId: request.sessionId,
                    source: request.source,
                    externalKey: request.externalKey,
                },
                select: { id: true, createdAt: true },
            });
            if (existing) {
                return { ok: true, event: existing };
            }
        }

        const created = await tx.usageEvent.create({
            data: toUsageEventCreateInput(accountId, request),
            select: { id: true, createdAt: true },
        });

        return { ok: true, event: created };
    });
}

export async function recordLegacyUsageReport(
    params: LegacyUsageReportInput,
): Promise<RecordLegacyUsageReportResult> {
    const accountId = params.accountId.trim();
    const key = params.key.trim();
    const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim() ? params.sessionId : null;

    if (!accountId || !key || typeof params.tokens.total !== 'number' || typeof params.cost.total !== 'number') {
        return { ok: false, error: 'invalid-params' };
    }

    return await inTx(async (tx) => {
        if (sessionId && !(await ensureSessionOwnedByAccount(tx, { accountId, sessionId }))) {
            return { ok: false, error: 'session-not-found' };
        }

        const previous = sessionId
            ? await tx.usageReport.findUnique({
                where: {
                    accountId_sessionId_key: {
                        accountId,
                        sessionId,
                        key,
                    },
                },
                select: { data: true },
            })
            : await tx.usageReport.findFirst({
                where: {
                    accountId,
                    sessionId: null,
                    key,
                },
                select: { data: true },
            });

        const usageData: PrismaJson.UsageReportData = {
            tokens: params.tokens,
            cost: params.cost,
        };
        const now = new Date();
        const report = sessionId
            ? await tx.usageReport.upsert({
                where: {
                    accountId_sessionId_key: {
                        accountId,
                        sessionId,
                        key,
                    },
                },
                update: {
                    data: usageData,
                    updatedAt: now,
                },
                create: {
                    accountId,
                    sessionId,
                    key,
                    data: usageData,
                },
                select: {
                    id: true,
                    createdAt: true,
                    updatedAt: true,
                },
            })
            : await (async () => {
                const existing = await tx.usageReport.findFirst({
                    where: {
                        accountId,
                        sessionId: null,
                        key,
                    },
                    select: {
                        id: true,
                    },
                });
                if (existing) {
                    return await tx.usageReport.update({
                        where: { id: existing.id },
                        data: {
                            data: usageData,
                            updatedAt: now,
                        },
                        select: {
                            id: true,
                            createdAt: true,
                            updatedAt: true,
                        },
                    });
                }
                return await tx.usageReport.create({
                    data: {
                        accountId,
                        sessionId: null,
                        key,
                        data: usageData,
                    },
                    select: {
                        id: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                });
            })();

        const deltaRequest = buildLegacyDeltaRequest({
            key,
            sessionId,
            nextUsage: usageData,
            previousUsage: (previous?.data as PrismaJson.UsageReportData | null | undefined) ?? null,
            observedAtMs: report.updatedAt.getTime(),
        });

        let usageEventId: string | null = null;
        if (deltaRequest) {
            const created = await tx.usageEvent.create({
                data: toUsageEventCreateInput(accountId, deltaRequest),
                select: { id: true },
            });
            usageEventId = created.id;
        }

        if (sessionId) {
            afterTx(tx, () => {
                const usageEvent = buildUsageEphemeral(
                    sessionId,
                    key,
                    params.tokens,
                    params.cost,
                );
                eventRouter.emitEphemeral({
                    userId: accountId,
                    payload: usageEvent,
                    recipientFilter: { type: 'user-scoped-only' },
                });
            });
        }

        return {
            ok: true,
            report,
            usageEventId,
        };
    });
}
