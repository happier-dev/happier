import { Prisma } from "@prisma/client";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

type PruneKind = "session" | "share" | "machine" | "artifact";

const PRUNE_TARGETS: Array<{ kind: PruneKind; table: "Session" | "Machine" | "Artifact" }> = [
    { kind: "session", table: "Session" },
    // Share changes are keyed by sessionId too (entityId=sessionId).
    { kind: "share", table: "Session" },
    { kind: "machine", table: "Machine" },
    { kind: "artifact", table: "Artifact" },
];

export async function pruneOrphanAccountChangesOnce(): Promise<{
    deletedRows: number;
    affectedAccounts: number;
}> {
    let deletedRows = 0;
    const floorByAccountId = new Map<string, number>();

    for (const target of PRUNE_TARGETS) {
        const table = Prisma.raw(`"${target.table}"`);
        // Delete + RETURNING is atomic and ensures we don't miss the max cursor of rows deleted in this pass.
        const deleted = await db.$queryRaw<Array<{ accountId: string; cursor: number }>>(
            Prisma.sql`
                DELETE FROM "AccountChange" ac
                WHERE ac."kind" = ${target.kind}
                AND NOT EXISTS (
                    SELECT 1 FROM ${table} t WHERE t."id" = ac."entityId"
                )
                RETURNING ac."accountId" AS "accountId", ac."cursor" AS "cursor"
            `,
        );

        deletedRows += deleted.length;
        for (const row of deleted) {
            if (!row || typeof row.accountId !== "string") continue;
            const cursor = Number((row as any).cursor);
            if (!Number.isFinite(cursor) || cursor <= 0) continue;
            const existing = floorByAccountId.get(row.accountId) ?? 0;
            if (cursor > existing) {
                floorByAccountId.set(row.accountId, cursor);
            }
        }
    }

    // Bump the per-account prune floor so clients behind it are forced to do a snapshot rebuild (410 Gone).
    for (const [accountId, floor] of floorByAccountId) {
        await db.$executeRaw(
            Prisma.sql`
                UPDATE "Account"
                SET "changesFloor" = GREATEST("changesFloor", ${floor})
                WHERE "id" = ${accountId}
            `,
        );
    }

    return { deletedRows, affectedAccounts: floorByAccountId.size };
}

export function startAccountChangeCleanupFromEnv(): { stop: () => void } | null {
    const enabled =
        process.env.HAPPY_ACCOUNT_CHANGE_CLEANUP === "1" ||
        process.env.HAPPY_ACCOUNT_CHANGE_CLEANUP === "true";
    if (!enabled) return null;

    const intervalMsRaw = process.env.HAPPY_ACCOUNT_CHANGE_CLEANUP_INTERVAL_MS;
    const intervalMsParsed = intervalMsRaw ? Number(intervalMsRaw) : NaN;
    const intervalMs = Number.isFinite(intervalMsParsed) && intervalMsParsed >= 10_000
        ? Math.floor(intervalMsParsed)
        : 6 * 60 * 60 * 1000;

    let stopped = false;

    const run = async (reason: "startup" | "interval") => {
        try {
            const result = await pruneOrphanAccountChangesOnce();
            log(
                { module: "account-change-cleanup", reason, deletedRows: result.deletedRows, affectedAccounts: result.affectedAccounts },
                `AccountChange cleanup ran (${reason})`,
            );
        } catch (error) {
            log(
                { module: "account-change-cleanup", reason, error: error instanceof Error ? error.message : String(error) },
                `AccountChange cleanup failed (${reason})`,
            );
        }
    };

    void run("startup");
    const timer = setInterval(() => {
        if (stopped) return;
        void run("interval");
    }, intervalMs);
    timer.unref?.();

    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
}
