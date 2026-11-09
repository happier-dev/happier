import { isDeepStrictEqual } from "node:util";

import { usageReportWritesCounter } from "@/app/monitoring/metrics2";
import { IN_TX_OPERATION_LABELS, inTx, type Tx } from "@/storage/inTx";
import { AsyncLock } from "@/utils/runtime/lock";

type UsageReportWriteSummary = Readonly<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
}>;

export type RecordUsageReportResult =
    | Readonly<{
        ok: true;
        report: UsageReportWriteSummary;
        usageData: PrismaJson.UsageReportData;
        changed: boolean;
    }>
    | Readonly<{ ok: false; error: "session-not-found" }>;

type AccountUsageWriteLockState = {
    readonly lock: AsyncLock;
    refs: number;
};

const accountUsageWriteLocks = new Map<string, AccountUsageWriteLockState>();

async function inAccountUsageWriteLock<T>(
    params: Readonly<{ userId: string; key: string }>,
    run: () => Promise<T>,
): Promise<T> {
    const lockKey = `${params.userId}\0${params.key}`;
    let state = accountUsageWriteLocks.get(lockKey);
    if (!state) {
        state = { lock: new AsyncLock(), refs: 0 };
        accountUsageWriteLocks.set(lockKey, state);
    }
    state.refs += 1;
    try {
        return await state.lock.inLock(run);
    } finally {
        state.refs -= 1;
        if (state.refs === 0 && accountUsageWriteLocks.get(lockKey) === state) {
            accountUsageWriteLocks.delete(lockKey);
        }
    }
}

export async function recordUsageReportForAccount(params: Readonly<{
    userId: string;
    key: string;
    sessionId?: string | null;
    tokens: PrismaJson.UsageReportData["tokens"];
    cost: PrismaJson.UsageReportData["cost"];
}>): Promise<RecordUsageReportResult> {
    const sessionId = params.sessionId ?? null;
    const write = async (): Promise<RecordUsageReportResult> => await inTx(async (tx) => {
        if (sessionId) {
            const session = await tx.session.findFirst({
                where: { id: sessionId, accountId: params.userId },
                select: { id: true },
            });
            if (!session) {
                usageReportWritesCounter.inc({ scope: "session", result: "session_not_found" });
                return { ok: false as const, error: "session-not-found" };
            }
        }

        const usageData: PrismaJson.UsageReportData = {
            tokens: params.tokens,
            cost: params.cost,
        };
        const report = sessionId
            ? await recordSessionUsageReport(tx, {
                userId: params.userId,
                sessionId,
                key: params.key,
                usageData,
            })
            : await recordAccountLevelUsageReport(tx, {
                userId: params.userId,
                key: params.key,
                usageData,
            });

        return { ok: true as const, report: report.report, usageData, changed: report.changed };
    }, { diagnostics: { operation: IN_TX_OPERATION_LABELS.usageReportWrite } });
    return sessionId
        ? await write()
        : await inAccountUsageWriteLock({ userId: params.userId, key: params.key }, write);
}

async function recordSessionUsageReport(
    tx: Tx,
    params: Readonly<{
        userId: string;
        sessionId: string;
        key: string;
        usageData: PrismaJson.UsageReportData;
    }>,
): Promise<Readonly<{ report: UsageReportWriteSummary; changed: boolean }>> {
    const where = {
        accountId_sessionId_key: {
            accountId: params.userId,
            sessionId: params.sessionId,
            key: params.key,
        },
    } as const;
    const existing = await tx.usageReport.findUnique({
        where,
        select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            data: true,
        },
    });

    if (existing && isDeepStrictEqual(existing.data, params.usageData)) {
        usageReportWritesCounter.inc({ scope: "session", result: "unchanged" });
        return {
            report: {
                id: existing.id,
                createdAt: existing.createdAt,
                updatedAt: existing.updatedAt,
            },
            changed: false,
        };
    }

    const report = await tx.usageReport.upsert({
        where,
        update: {
            data: params.usageData,
            updatedAt: new Date(),
        },
        create: {
            accountId: params.userId,
            sessionId: params.sessionId,
            key: params.key,
            data: params.usageData,
        },
        select: {
            id: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    usageReportWritesCounter.inc({ scope: "session", result: existing ? "updated" : "created" });
    return { report, changed: true };
}

async function recordAccountLevelUsageReport(
    tx: Tx,
    params: Readonly<{
        userId: string;
        key: string;
        usageData: PrismaJson.UsageReportData;
    }>,
): Promise<Readonly<{ report: UsageReportWriteSummary; changed: boolean }>> {
    const existingReports = await tx.usageReport.findMany({
        where: {
            accountId: params.userId,
            sessionId: null,
            key: params.key,
        },
        orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
        ],
        select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            data: true,
        },
    });

    const [existing, ...duplicates] = existingReports;
    if (existing) {
        if (duplicates.length > 0) {
            await tx.usageReport.deleteMany({
                where: {
                    accountId: params.userId,
                    sessionId: null,
                    key: params.key,
                    id: { in: duplicates.map((report) => report.id) },
                },
            });
        }

        const dataUnchanged = isDeepStrictEqual(existing.data, params.usageData);
        if (dataUnchanged) {
            const result = {
                report: {
                    id: existing.id,
                    createdAt: existing.createdAt,
                    updatedAt: existing.updatedAt,
                },
                changed: duplicates.length > 0,
            };
            usageReportWritesCounter.inc({
                scope: "account",
                result: result.changed ? "updated" : "unchanged",
            });
            return result;
        }

        const report = await tx.usageReport.update({
            where: { id: existing.id },
            data: {
                data: params.usageData,
                updatedAt: new Date(),
            },
            select: {
                id: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        usageReportWritesCounter.inc({ scope: "account", result: "updated" });
        return { report, changed: true };
    }

    const report = await tx.usageReport.create({
        data: {
            accountId: params.userId,
            sessionId: null,
            key: params.key,
            data: params.usageData,
        },
        select: {
            id: true,
            createdAt: true,
            updatedAt: true,
        },
    });
    usageReportWritesCounter.inc({ scope: "account", result: "created" });
    return { report, changed: true };
}
