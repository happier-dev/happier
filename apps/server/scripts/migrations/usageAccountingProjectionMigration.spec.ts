import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const migration = "20261102221000_usage_accounting_projection";

describe("derived Usage accounting projection migration", () => {
    it.each(["sqlite", "postgres"] as const)("preserves existing Accounts and stores isolated rebuildable state on %s", async provider => {
        const sqlite = provider === "sqlite" ? new DatabaseSync(":memory:") : null;
        const postgres = provider === "postgres" ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        const migrations = sqlite ? "prisma/sqlite/migrations" : "prisma/migrations";
        try {
            // The immutable provider baseline supplies the actual Account key/FK target.
            const baseline = sqlite ? "20260122190000_baseline" : "20250713002718_initial";
            await execute(await readFile(join(root, migrations, baseline, "migration.sql"), "utf8"));
            if (sqlite) sqlite.exec("PRAGMA foreign_keys=ON");
            await execute(`INSERT INTO "Account" ("id","publicKey","updatedAt") VALUES ('alice','alice',CURRENT_TIMESTAMP),('bob','bob',CURRENT_TIMESTAMP)`);
            const accounts = await query('SELECT * FROM "Account" ORDER BY "id"');
            await execute(await readFile(join(root, migrations, migration, "migration.sql"), "utf8"));
            expect(await query('SELECT * FROM "Account" ORDER BY "id"')).toEqual(accounts);
            const payload = JSON.stringify({ subject: "native/" + "機".repeat(1000), exact: "0.0000000000000000001", body: "p".repeat(70_000) });
            const insert = (recordKey: string, accountId: string, kind: string, full: boolean) => execute(`INSERT INTO "UsageAccountingProjection"
                ("recordKey","accountId","kind","subjectHash","itemKey","sessionId","observedAtMs","validFromMs","validUntilMs","ordinal","payload")
                VALUES ('${recordKey}','${accountId}','${kind}',${full ? `'${"c".repeat(64)}','${"d".repeat(64)}','historical-session'` : 'NULL,NULL,NULL'},1702018460000,1700000000000,${full ? '1702018460001,7' : 'NULL,NULL'},'${payload}')`);
            await insert("a".repeat(64), "alice", "contribution", true);
            await insert("b".repeat(64), "bob", "state", false);
            const rows = await query('SELECT "accountId","payload","sessionId","ordinal" FROM "UsageAccountingProjection" ORDER BY "accountId"');
            expect(rows).toEqual([{ accountId: "alice", payload, sessionId: "historical-session", ordinal: 7 },
                { accountId: "bob", payload, sessionId: null, ordinal: null }]);
            await expect(insert("a".repeat(64), "bob", "state", false)).rejects.toThrow();
            await expect(insert("e".repeat(64), "missing", "checkpoint", false)).rejects.toThrow();
            const indexes = sqlite
                ? (await query(`SELECT name FROM pragma_index_list('UsageAccountingProjection') WHERE origin='c'`)).map(row => row.name)
                : (await query(`SELECT indexname AS name FROM pg_indexes WHERE tablename='UsageAccountingProjection' AND indexname NOT LIKE '%pkey'`)).map(row => row.name);
            expect(indexes.sort()).toEqual([
                "UsageAccountingProjection_accountId_kind_itemKey_idx",
                "UsageAccountingProjection_accountId_kind_observedAtMs_idx",
                "UsageAccountingProjection_accountId_kind_sessionId_idx",
                "UsageAccountingProjection_accountId_kind_subjectHash_idx",
            ]);
            await execute(`DELETE FROM "Account" WHERE "id"='alice'`);
            expect(await query('SELECT "accountId" FROM "UsageAccountingProjection"')).toEqual([{ accountId: "bob" }]);
            if (sqlite) expect(await query("PRAGMA foreign_key_check")).toEqual([]);
        } finally {
            sqlite?.close();
            await postgres?.close();
        }
    }, 60_000);
});
