import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
    UsageEventIngestRequest,
    UsageObservationCost,
    UsageObservationTokens,
} from "@happier-dev/protocol";
import { Prisma } from "@prisma/client";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { usageReportWritesCounter } from "@/app/monitoring/metrics/index";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { AsyncLock } from "@/utils/runtime/lock";
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
        changed: boolean;
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

type UsageReportWriteMetric = Readonly<{
    scope: "account" | "session";
    result: "created" | "updated" | "unchanged" | "session_not_found";
}>;

type AccountLegacyUsageWriteLockState = {
    readonly lock: AsyncLock;
    refs: number;
};

const accountLegacyUsageWriteLocks = new Map<string, AccountLegacyUsageWriteLockState>();

async function inAccountLegacyUsageWriteLock<T>(
    params: Readonly<{ accountId: string; key: string }>,
    run: () => Promise<T>,
): Promise<T> {
    const lockKey = `${params.accountId}\0${params.key}`;
    let state = accountLegacyUsageWriteLocks.get(lockKey);
    if (!state) {
        state = { lock: new AsyncLock(), refs: 0 };
        accountLegacyUsageWriteLocks.set(lockKey, state);
    }
    state.refs += 1;
    try {
        return await state.lock.inLock(run);
    } finally {
        state.refs -= 1;
        if (state.refs === 0 && accountLegacyUsageWriteLocks.get(lockKey) === state) {
            accountLegacyUsageWriteLocks.delete(lockKey);
        }
    }
}

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
        idempotencyKey: buildUsageEventIdempotencyKey(accountId, request),
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

function buildUsageEventIdempotencyKey(
    accountId: string,
    request: Pick<UsageEventIngestRequest, "sessionId" | "source" | "externalKey">,
): string | null {
    if (!request.externalKey) {
        return null;
    }

    const rawKey = JSON.stringify([accountId, request.sessionId, request.source, request.externalKey]);
    const digest = createHash("sha256").update(rawKey).digest("hex");
    return `usage_event:v1:${digest}`;
}

function buildLegacyUsageEventIdempotencyKey(
    accountId: string,
    request: Pick<UsageEventIngestRequest, "sessionId" | "source" | "externalKey">,
): string | null {
    if (!request.externalKey) {
        return null;
    }

    return JSON.stringify([accountId, request.sessionId, request.source, request.externalKey]);
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
            const idempotencyKey = buildUsageEventIdempotencyKey(accountId, request);
            const legacyIdempotencyKey = buildLegacyUsageEventIdempotencyKey(accountId, request);
            const existingByCurrentKey = await tx.usageEvent.findUnique({
                where: {
                    idempotencyKey: idempotencyKey ?? "",
                },
                select: { id: true, createdAt: true },
            });
            if (existingByCurrentKey) {
                return { ok: true, event: existingByCurrentKey };
            }

            if (legacyIdempotencyKey) {
                const existingByLegacyKey = await tx.usageEvent.findUnique({
                    where: {
                        idempotencyKey: legacyIdempotencyKey,
                    },
                    select: { id: true, createdAt: true },
                });
                if (existingByLegacyKey) {
                    return { ok: true, event: existingByLegacyKey };
                }
            }

            const created = await tx.usageEvent.upsert({
                where: {
                    idempotencyKey: idempotencyKey ?? "",
                },
                update: {},
                create: toUsageEventCreateInput(accountId, request),
                select: { id: true, createdAt: true },
            });
            return { ok: true, event: created };
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
    const scope = sessionId ? "session" : "account";
    let writeMetric: UsageReportWriteMetric | null = null;

    if (!accountId || !key || typeof params.tokens.total !== 'number' || typeof params.cost.total !== 'number') {
        return { ok: false, error: 'invalid-params' };
    }

    const write = async (): Promise<RecordLegacyUsageReportResult> => await inTx<RecordLegacyUsageReportResult>(async (tx) => {
        if (sessionId && !(await ensureSessionOwnedByAccount(tx, { accountId, sessionId }))) {
            writeMetric = { scope: "session", result: "session_not_found" };
            return { ok: false, error: 'session-not-found' };
        }

        let previous: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            data: Prisma.JsonValue;
        } | null = null;
        let removedDuplicateAccountReports = false;

        if (sessionId) {
            previous = await tx.usageReport.findUnique({
                where: {
                    accountId_sessionId_key: {
                        accountId,
                        sessionId,
                        key,
                    },
                },
                select: { id: true, createdAt: true, updatedAt: true, data: true },
            });
        } else {
            const existingReports = await tx.usageReport.findMany({
                where: {
                    accountId,
                    sessionId: null,
                    key,
                },
                orderBy: [
                    { updatedAt: "desc" },
                    { createdAt: "desc" },
                    { id: "desc" },
                ],
                select: { id: true, createdAt: true, updatedAt: true, data: true },
            });
            const [survivor, ...duplicates] = existingReports;
            previous = survivor ?? null;
            if (duplicates.length > 0) {
                await tx.usageReport.deleteMany({
                    where: {
                        accountId,
                        sessionId: null,
                        key,
                        id: { in: duplicates.map((report) => report.id) },
                    },
                });
                removedDuplicateAccountReports = true;
            }
        }

        const usageData: PrismaJson.UsageReportData = {
            tokens: params.tokens,
            cost: params.cost,
        };

        if (previous && isDeepStrictEqual(previous.data, usageData)) {
            writeMetric = { scope, result: removedDuplicateAccountReports ? "updated" : "unchanged" };
            return {
                ok: true,
                changed: removedDuplicateAccountReports,
                report: {
                    id: previous.id,
                    createdAt: previous.createdAt,
                    updatedAt: previous.updatedAt,
                },
                usageEventId: null,
            };
        }

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
                if (previous) {
                    return await tx.usageReport.update({
                        where: { id: previous.id },
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

        writeMetric = { scope, result: previous ? "updated" : "created" };
        return {
            ok: true,
            changed: true,
            report,
            usageEventId,
        };
    });
    const result = sessionId
        ? await write()
        : await inAccountLegacyUsageWriteLock({ accountId, key }, write);

    if (writeMetric) {
        usageReportWritesCounter.inc(writeMetric);
    }

    return result;
}
