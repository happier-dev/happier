import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const migration = "20261112203500_provider_account_usage_day_summary";
const pendingIndexMigration = "20261112211000_provider_usage_pending_day_index";

describe("Provider Account quota daily summary migration", () => {
    it.each(["sqlite", "postgres"] as const)("preserves detail and binds summaries to their exact parent on %s", async provider => {
        const sqlite = provider === "sqlite" ? new DatabaseSync(":memory:") : null;
        const postgres = provider === "postgres" ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        const migrations = join(root, sqlite ? "prisma/sqlite/migrations" : "prisma/migrations");
        try {
            const baseline = sqlite ? "20260122190000_baseline" : "20250713002718_initial";
            await execute(await readFile(join(migrations, baseline, "migration.sql"), "utf8"));
            if (sqlite) sqlite.exec("PRAGMA foreign_keys=ON");
            await execute(await readFile(join(migrations, "20260630162000_add_provider_account_usage_records/migration.sql"), "utf8"));
            await execute(await readFile(join(migrations, "20261009120000_provider_account_usage_history/migration.sql"), "utf8"));
            await execute(`INSERT INTO "Account" ("id","publicKey","updatedAt") VALUES ('alice','alice',CURRENT_TIMESTAMP),('bob','bob',CURRENT_TIMESTAMP)`);
            for (const account of ["alice", "bob"]) {
                await execute(`INSERT INTO "ProviderAccountUsageRecord"
                    ("id","accountId","providerId","recordId","accountSubjectId","subjectKind","quotaScope","quotaScopeIdKey","recordKeyJson","payloadMode","status","updatedAt")
                    VALUES ('${account}','${account}','vendor','shared-record','subject','account','account','','{}','plain','ready',CURRENT_TIMESTAMP)`);
                await execute(`INSERT INTO "ProviderAccountUsageHistory" ("id","accountId","recordId","observedAt","payload")
                    VALUES ('${account}','${account}','shared-record','2026-01-01','{}')`);
            }
            const detail = await query('SELECT * FROM "ProviderAccountUsageHistory" ORDER BY "id"');
            const migrationPath = join(migrations, migration, "migration.sql");
            if (existsSync(migrationPath)) await execute(await readFile(migrationPath, "utf8"));
            expect(await query('SELECT * FROM "ProviderAccountUsageHistory" ORDER BY "id"')).toEqual(detail);
            const insert = (account: string, record: string, day: string, count = 1) => execute(`INSERT INTO "ProviderAccountUsageDaySummary"
                ("accountId","recordId","dayStartAt","payload") VALUES ('${account}','${record}','${day}','{"v":1,"coverage":{"observationCount":${count},"frontier":null},"content":{"t":"plain","v":{"windows":[]}}}')`);
            await insert("alice", "shared-record", "2026-01-01");
            await insert("bob", "shared-record", "2026-01-01");
            await insert("alice", "shared-record", "2026-01-02");
            for (let day = 0; day < 100; day++) {
                await insert("bob", "shared-record", new Date(Date.UTC(2000, 0, 1 + day)).toISOString(), 0);
            }
            const pendingIndexPath = join(migrations, pendingIndexMigration, "migration.sql");
            if (existsSync(pendingIndexPath)) await execute(await readFile(pendingIndexPath, "utf8"));
            if (sqlite) {
                let visited = 0;
                sqlite.function("candidate_probe", () => { visited++; return 1; });
                const candidates = `SELECT "dayStartAt" FROM "ProviderAccountUsageDaySummary"
                    WHERE "dayStartAt"<'2026-01-03' AND candidate_probe()
                    AND json_extract("payload", '$.coverage.observationCount') > 0
                    ORDER BY "dayStartAt", "accountId", "recordId" LIMIT 1`;
                expect(await query(candidates)).toEqual([{ dayStartAt: "2026-01-01" }]);
                expect(visited, "compacted summaries must not enter the pending-day scan").toBe(1);
                const plan = await query(`EXPLAIN QUERY PLAN ${candidates}`);
                expect(plan.some(row => String(row.detail).includes("pauds_day_idx"))).toBe(true);
                await execute(`UPDATE "ProviderAccountUsageDaySummary" SET "payload"=json_set("payload", '$.coverage.observationCount', 0)`);
                visited = 0;
                expect(await query(candidates)).toEqual([]);
                expect(visited, "fully compacted summaries must leave no pending scan work").toBe(0);
            }
            await execute(`DELETE FROM "ProviderAccountUsageDaySummary" WHERE "dayStartAt"<'2026-01-01'`);
            await expect(insert("alice", "shared-record", "2026-01-01")).rejects.toThrow();
            await expect(insert("alice", "missing-record", "2026-01-01")).rejects.toThrow();
            await execute(`UPDATE "ProviderAccountUsageRecord" SET "recordId"='renamed' WHERE "accountId"='alice'`);
            expect(await query('SELECT "recordId" FROM "ProviderAccountUsageDaySummary" WHERE "accountId"=\'alice\''))
                .toEqual([{ recordId: "renamed" }, { recordId: "renamed" }]);
            await execute(`DELETE FROM "ProviderAccountUsageRecord" WHERE "accountId"='alice'`);
            expect(await query('SELECT "accountId" FROM "ProviderAccountUsageDaySummary"')).toEqual([{ accountId: "bob" }]);
            expect(await query('SELECT "accountId" FROM "ProviderAccountUsageHistory"')).toEqual([{ accountId: "bob" }]);
            if (sqlite) {
                expect(await query("PRAGMA foreign_key_check")).toEqual([]);
            }
        } finally {
            sqlite?.close();
            await postgres?.close();
        }
    });
});
