import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const migration = "20261008130000_requester_machine_access_key_binding";

describe("requester Machine AccessKey migration", () => {
    it.each(["sqlite", "postgres"] as const)("preserves predecessor tuples while separating requester from custodian on %s", async (provider) => {
        const sqlite = provider === "sqlite" ? new DatabaseSync(":memory:") : null;
        const postgres = provider === "postgres" ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        const migrations = provider === "sqlite" ? "prisma/sqlite/migrations" : "prisma/migrations";
        try {
            // These immutable migrations contain the actual same-owner predecessor
            // FK and column/index types; this test does not reconstruct that FK.
            const baseline = sqlite ? ["20260122190000_baseline"] : [
                "20250713002718_initial", "20250713004156_add_sessions",
                "20250812092041_add_machine_model", "20250917055002_add_access_key",
            ];
            for (const name of baseline) await execute(await readFile(join(root, migrations, name, "migration.sql"), "utf8"));
            if (sqlite) sqlite.exec("PRAGMA foreign_keys=ON");
            await execute(`INSERT INTO "Account" ("id","publicKey","updatedAt") VALUES ('alice','alice',CURRENT_TIMESTAMP),('bob','bob',CURRENT_TIMESTAMP);
                INSERT INTO "Machine" ("id","accountId","metadata","updatedAt") VALUES ('alice-machine','alice','{}',CURRENT_TIMESTAMP);
                INSERT INTO "Session" ("id","accountId",${sqlite ? '"tag","metadata",' : ''}"updatedAt") VALUES ('alice-session','alice',${sqlite ? "'alice-session','{}'," : ''}CURRENT_TIMESTAMP),('bob-session','bob',${sqlite ? "'bob-session','{}'," : ''}CURRENT_TIMESTAMP);
                INSERT INTO "AccessKey" ("id","accountId","machineId","sessionId","data","dataVersion","createdAt","updatedAt")
                    VALUES ('old-key','alice','alice-machine','alice-session','opaque-predecessor',7,'2026-01-01 12:00:00','2026-01-02 12:00:00');`);
            const before = await query('SELECT * FROM "AccessKey"');
            await execute(await readFile(join(root, migrations, migration, "migration.sql"), "utf8"));
            expect(await query('SELECT * FROM "AccessKey"')).toEqual(before);
            const insert = (id: string, accountId = "bob", machineId = "alice-machine", sessionId = "bob-session") => execute(
                `INSERT INTO "AccessKey" ("id","accountId","machineId","sessionId","data","dataVersion","updatedAt") VALUES ('${id}','${accountId}','${machineId}','${sessionId}','opaque-requester',9,CURRENT_TIMESTAMP)`,
            );
            await insert("new-key");
            expect(await query('SELECT "accountId","machineId","sessionId","dataVersion" FROM "AccessKey" WHERE "id"=\'new-key\''))
                .toEqual([{ accountId: "bob", machineId: "alice-machine", sessionId: "bob-session", dataVersion: 9 }]);
            await expect(insert("duplicate")).rejects.toThrow();
            await expect(insert("missing-machine", "bob", "missing")).rejects.toThrow();
            await expect(insert("missing-account", "missing")).rejects.toThrow();
            await expect(insert("missing-session", "bob", "alice-machine", "missing")).rejects.toThrow();
            await expect(execute('DELETE FROM "Machine" WHERE "id"=\'alice-machine\'')).rejects.toThrow();
            await expect(execute('DELETE FROM "Session" WHERE "id"=\'bob-session\'')).rejects.toThrow();
            await execute('DELETE FROM "AccessKey" WHERE "machineId"=\'alice-machine\'');
            expect(await query('SELECT "id" FROM "Session" ORDER BY "id"')).toEqual([{ id: "alice-session" }, { id: "bob-session" }]);
            if (sqlite) expect(await query("PRAGMA foreign_key_check")).toEqual([]);
        } finally {
            sqlite?.close();
            await postgres?.close();
        }
    }, 60_000);
});
