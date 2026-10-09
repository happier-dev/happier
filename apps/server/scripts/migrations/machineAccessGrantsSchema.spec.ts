import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "../..");
const sharingMigration = "20261008144600_add_machine_access_grants";

describe("Machine sharing migration constraints", () => {
    it.each(["sqlite", "postgres"] as const)("enforces principal tuples, roles and envelope lifetimes on %s", async (provider) => {
        const sqlite = provider === "sqlite" ? new DatabaseSync(":memory:") : null;
        const postgres = provider === "postgres" ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        const migrationRoot = join(serverRoot, provider === "sqlite" ? "prisma/sqlite/migrations" : "prisma/migrations");
        try {
            // Use the actual immutable parent migrations, not reconstructed FK fixtures.
            for (const migration of sqlite ? ["20260122190000_baseline"] : [
                "20250713002718_initial", "20250713004156_add_sessions", "20250812092041_add_machine_model",
            ]) await execute(await readFile(join(migrationRoot, migration, "migration.sql"), "utf8"));
            await execute(await readFile(join(migrationRoot, "20260905220000_add_team_home_governance", "migration.sql"), "utf8"));
            if (sqlite) sqlite.exec("PRAGMA foreign_keys=ON");
            await execute(`INSERT INTO "Account" ("id","publicKey","updatedAt") VALUES ('owner','owner',CURRENT_TIMESTAMP),('recipient','recipient',CURRENT_TIMESTAMP);
                INSERT INTO "Machine" ("id","accountId","metadata","updatedAt") VALUES ('machine','owner','{}',CURRENT_TIMESTAMP);
                INSERT INTO "Team" ("id","name","updatedAt") VALUES ('team','Team',CURRENT_TIMESTAMP);
                INSERT INTO "TeamGroup" ("id","teamId","name","nameKey","updatedAt") VALUES ('group','team','Group','group',CURRENT_TIMESTAMP);`);
            await execute(await readFile(join(migrationRoot, sharingMigration, "migration.sql"), "utf8"));
            for (const [table, principalColumn, principal] of [
                ["MachineAccountGrant", "accountId", "recipient"],
                ["MachineTeamGrant", "teamId", "team"],
                ["MachineGroupGrant", "teamGroupId", "group"],
            ] as const) {
                const insert = (machine = "machine", recipient: string = principal, role = "view", creator = "owner") => execute(
                    `INSERT INTO "${table}" ("machineId","${principalColumn}","accessLevel","createdByAccountId") VALUES ('${machine}','${recipient}','${role}','${creator}')`,
                );
                await expect(insert("machine", principal, "edit")).rejects.toThrow();
                await expect(insert("missing")).rejects.toThrow();
                await expect(insert("machine", "missing")).rejects.toThrow();
                await expect(insert("machine", principal, "view", "missing")).rejects.toThrow();
                await insert();
                await expect(insert()).rejects.toThrow();
                await execute(`UPDATE "${table}" SET "accessLevel"='admin' WHERE "machineId"='machine'`);
                expect(await query(`SELECT "accessLevel" FROM "${table}"`)).toEqual([{ accessLevel: "admin" }]);
            }
            const envelope = (machine = "machine", recipient = "recipient") => execute(
                `INSERT INTO "MachineKeyEnvelope" ("machineId","recipientAccountId","encryptedDataKey","machineOwnerEnvelopeFingerprint","recipientContentPublicKeyFingerprint","updatedAt")
                VALUES ('${machine}','${recipient}',${sqlite ? "X'0102'" : "decode('0102','hex')"},'owner-envelope','recipient-binding',CURRENT_TIMESTAMP)`,
            );
            await expect(envelope("missing")).rejects.toThrow();
            await expect(envelope("machine", "missing")).rejects.toThrow();
            await envelope();
            await expect(envelope()).rejects.toThrow();
            expect(await query('SELECT "machineOwnerEnvelopeFingerprint","recipientContentPublicKeyFingerprint" FROM "MachineKeyEnvelope"'))
                .toEqual([{ machineOwnerEnvelopeFingerprint: "owner-envelope", recipientContentPublicKeyFingerprint: "recipient-binding" }]);
            await execute('DELETE FROM "Account" WHERE "id"=\'recipient\'');
            expect(await query('SELECT * FROM "MachineKeyEnvelope"')).toEqual([]);
            await execute('DELETE FROM "Machine" WHERE "id"=\'machine\'');
            for (const table of ["MachineAccountGrant", "MachineTeamGrant", "MachineGroupGrant"]) {
                expect(await query(`SELECT * FROM "${table}"`)).toEqual([]);
            }
            if (sqlite) expect(await query("PRAGMA foreign_key_check")).toEqual([]);
        } finally {
            sqlite?.close();
            await postgres?.close();
        }
    }, 60_000);
});
