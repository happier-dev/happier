import { db } from "@/storage/db";
import { log } from "@/utils/log";

type PruneKind = "session" | "share" | "machine" | "artifact";

type PruneTarget = {
    kinds: PruneKind[];
    fkField: "sessionId" | "machineId" | "artifactId";
};

const PRUNE_TARGETS: PruneTarget[] = [
    // Session + share changes are keyed by sessionId (entityId=sessionId).
    { kinds: ["session", "share"], fkField: "sessionId" },
    { kinds: ["machine"], fkField: "machineId" },
    { kinds: ["artifact"], fkField: "artifactId" },
];

export async function pruneOrphanAccountChangesOnce(): Promise<{
    deletedRows: number;
    affectedAccounts: number;
}> {
    let deletedRows = 0;
    const floorByAccountId = new Map<string, number>();

    for (const target of PRUNE_TARGETS) {
        const baseWhere: any = {
            kind: { in: target.kinds },
            [target.fkField]: null,
        };

        const grouped = await db.accountChange.groupBy({
            by: ["accountId"],
            where: baseWhere,
            _max: { cursor: true },
        });

        // Delete in per-account batches bounded by the observed max cursor, so we never delete rows
        // beyond the floor we are about to bump. This prevents race conditions where newly-orphaned
        // rows could be deleted without being covered by changesFloor.
        for (const g of grouped as Array<{ accountId: string; _max: { cursor: number | null } }>) {
            if (!g || typeof g.accountId !== "string") continue;
            const cursor = Number(g._max?.cursor);
            if (!Number.isFinite(cursor) || cursor <= 0) continue;

            const deleted = await db.accountChange.deleteMany({
                where: {
                    ...baseWhere,
                    accountId: g.accountId,
                    cursor: { lte: cursor },
                },
            });
            deletedRows += deleted.count;

            const existing = floorByAccountId.get(g.accountId) ?? 0;
            if (cursor > existing) {
                floorByAccountId.set(g.accountId, cursor);
            }
        }
    }

    // Bump the per-account prune floor so clients behind it are forced to do a snapshot rebuild (410 Gone).
    for (const [accountId, floor] of floorByAccountId) {
        await db.account.updateMany({
            where: {
                id: accountId,
                changesFloor: { lt: floor },
            },
            data: {
                changesFloor: floor,
            },
        });
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
