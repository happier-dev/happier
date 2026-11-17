import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { applyPostgresMigrations, applySqliteMigrations } from "../prismaMigrations";
import { createDbMaintenanceClient } from "../../sources/storage/prisma";

const migrationName = "20260905220000_add_team_home_governance";
const machinePoolMigrationName = "20260905233000_add_machine_pools";
const serverRoot = join(import.meta.dirname, "../..");

describe("Team/Home governance and Machine Pool persistence", () => {
    it.each(["sqlite", "postgres"] as const)("deploys twice and enforces governance plus Machine Pool storage on %s", async (provider) => {
        const directory = await mkdtemp(join(tmpdir(), "happier-teams-schema-"));
        const migrationsDir = join(directory, "migrations");
        const databasePath = join(directory, "test.sqlite");
        const sqlite = provider === "sqlite" ? new DatabaseSync(databasePath) : null;
        const postgres = provider === "postgres" ? new PGlite() : null;
        const longPoolName = `Unicode 池 🚀 ${"n".repeat(512)}`;
        const exec = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        const deploy = () => sqlite
            ? applySqliteMigrations({ databasePath, migrationsDir })
            : applyPostgresMigrations({ db: postgres!, migrationsDir });
        const root = provider === "sqlite" ? "prisma/sqlite" : "prisma";
        // Real immutable server-v0.2.11 / preview.2 @98ea8fb schema, not reconstructed columns.
        const baseline = provider === "sqlite" ? "20260122190000_baseline" : "20250713002718_initial";
        try {
            await mkdir(join(migrationsDir, baseline), { recursive: true });
            await writeFile(join(migrationsDir, baseline, "migration.sql"), await readFile(join(serverRoot, root, "migrations", baseline, "migration.sql")));
            if (provider === "postgres") {
                const machineMigration = "20250812092041_add_machine_model";
                await mkdir(join(migrationsDir, machineMigration));
                await writeFile(
                    join(migrationsDir, machineMigration, "migration.sql"),
                    await readFile(join(serverRoot, root, "migrations", machineMigration, "migration.sql")),
                );
            }
            await deploy();
            if (sqlite) sqlite.exec("PRAGMA foreign_keys=ON");
            await exec(`INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES
                ('active','active',CURRENT_TIMESTAMP), ('expired','expired',CURRENT_TIMESTAMP),
                ('suspended','suspended',CURRENT_TIMESTAMP), ('lookalike','lookalike',CURRENT_TIMESTAMP);`);
            const future = sqlite ? "4102444800000" : "'2100-01-01T00:00:00Z'";
            const past = sqlite ? "946684800000" : "'2000-01-01T00:00:00Z'";
            if (sqlite) {
                const client = await createDbMaintenanceClient("sqlite", `file:${databasePath}`);
                try {
                    // Characterize the real Prisma writer rather than guessing SQLite DateTime storage.
                    await client.repeatKey.create({ data: {
                        key: "auth_disabled_suspended", value: "retirement", expiresAt: new Date("2100-01-01T00:00:00Z"),
                    } });
                    expect(await query(`SELECT typeof("expiresAt") AS representation FROM "RepeatKey" WHERE "key"='auth_disabled_suspended'`)).toEqual([{ representation: "integer" }]);
                } finally {
                    await client.$disconnect();
                }
            } else {
                await exec(`INSERT INTO "RepeatKey" ("key","value","expiresAt") VALUES ('auth_disabled_suspended','retirement',${future})`);
            }
            await exec(`INSERT INTO "RepeatKey" ("key","value","expiresAt") VALUES
                ('auth_disabled_expired','expired',${past}),
                ('authXdisabledXlookalike','unrelated',${future}),
                ('oauth_pending_active','keep',${future});`);
            // On RED the current migration set deploys successfully, then the missing behavior fails.
            const sql = await readFile(join(serverRoot, root, "migrations", migrationName, "migration.sql"), "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (sql !== null) {
                await mkdir(join(migrationsDir, migrationName));
                await writeFile(join(migrationsDir, migrationName, "migration.sql"), sql);
            }
            await mkdir(join(migrationsDir, machinePoolMigrationName));
            await writeFile(
                join(migrationsDir, machinePoolMigrationName, "migration.sql"),
                await readFile(join(serverRoot, root, "migrations", machinePoolMigrationName, "migration.sql")),
            );
            await deploy();
            expect(await query('SELECT "id", "homeRole", "status" FROM "Account" ORDER BY "id"')).toEqual([
                { id: "active", homeRole: "member", status: "active" },
                { id: "expired", homeRole: "member", status: "active" },
                { id: "lookalike", homeRole: "member", status: "active" },
                { id: "suspended", homeRole: "member", status: "disabled" },
            ]);
            expect(await query('SELECT "key" FROM "RepeatKey" ORDER BY "key"')).toEqual([
                { key: "authXdisabledXlookalike" }, { key: "oauth_pending_active" },
            ]);
            await expect(deploy()).resolves.toEqual({ applied: [] });
            await exec(`INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES
                ('pool-owner','pool-owner',CURRENT_TIMESTAMP), ('pool-owner-cascade','pool-owner-cascade',CURRENT_TIMESTAMP);
                INSERT INTO "Machine" ("id","accountId","metadata","updatedAt") VALUES
                ('pool-machine-a','pool-owner','{}',CURRENT_TIMESTAMP), ('pool-machine-b','pool-owner','{}',CURRENT_TIMESTAMP);
                INSERT INTO "MachinePool" ("id","accountId","name","description","updatedAt") VALUES
                ('pool-machine-delete','pool-owner','Same name','first',CURRENT_TIMESTAMP),
                ('pool-direct-delete','pool-owner','Same name','second',CURRENT_TIMESTAMP),
                ('pool-account-delete','pool-owner-cascade','${longPoolName}','owned by account',CURRENT_TIMESTAMP);
                INSERT INTO "MachinePoolMember" ("poolId","machineId","priorityTier","enabled") VALUES
                ('pool-machine-delete','pool-machine-a',0,true),
                ('pool-direct-delete','pool-machine-b',7,false);`);
            expect(await query(`SELECT "id","accountId","name","description","revision" FROM "MachinePool" ORDER BY "id"`)).toEqual([
                { id: "pool-account-delete", accountId: "pool-owner-cascade", name: longPoolName, description: "owned by account", revision: 0 },
                { id: "pool-direct-delete", accountId: "pool-owner", name: "Same name", description: "second", revision: 0 },
                { id: "pool-machine-delete", accountId: "pool-owner", name: "Same name", description: "first", revision: 0 },
            ]);
            await exec("BEGIN");
            try {
                await exec(`INSERT INTO "MachinePool" ("id","accountId","name","updatedAt") VALUES ('pool-atomic','pool-owner','must roll back',CURRENT_TIMESTAMP)`);
                await expect(exec(`INSERT INTO "MachinePoolMember" ("poolId","machineId","priorityTier") VALUES ('pool-atomic','missing-machine',0)`)).rejects.toThrow();
            } finally {
                await exec("ROLLBACK");
            }
            expect(await query(`SELECT "id" FROM "MachinePool" WHERE "id"='pool-atomic'`)).toEqual([]);
            await exec(`DELETE FROM "Machine" WHERE "id"='pool-machine-a'`);
            expect(await query(`SELECT "poolId","machineId" FROM "MachinePoolMember" WHERE "poolId"='pool-machine-delete'`)).toEqual([]);
            expect(await query(`SELECT "id" FROM "MachinePool" WHERE "id"='pool-machine-delete'`)).toEqual([{ id: "pool-machine-delete" }]);
            await exec(`DELETE FROM "MachinePool" WHERE "id"='pool-direct-delete'`);
            expect(await query(`SELECT "poolId","machineId" FROM "MachinePoolMember" WHERE "poolId"='pool-direct-delete'`)).toEqual([]);
            await exec(`DELETE FROM "Account" WHERE "id"='pool-owner-cascade'`);
            expect(await query(`SELECT "id" FROM "MachinePool" WHERE "id"='pool-account-delete'`)).toEqual([]);
            await exec(`INSERT INTO "HomeGovernancePolicy" ("id","updatedAt") VALUES ('home',CURRENT_TIMESTAMP);
                INSERT INTO "Team" ("id","name","updatedAt") VALUES ('a','Same name',CURRENT_TIMESTAMP),('b','Same name',CURRENT_TIMESTAMP);
                INSERT INTO "TeamMembership" ("id","teamId","accountId","role") VALUES ('ma','a','active','owner'),('mb','b','expired','guest');
                INSERT INTO "TeamGroup" ("id","teamId","name","nameKey","updatedAt") VALUES
                    ('design','a','Design','design',CURRENT_TIMESTAMP),
                    ('resume-plain','a','Resume','resume',CURRENT_TIMESTAMP),
                    ('resume-accent','a','Résumé','résumé',CURRENT_TIMESTAMP);
                INSERT INTO "TeamGroupMembership" ("teamId","teamGroupId","teamMembershipId","nativeContribution") VALUES ('a','design','ma',true);`);
            expect(await query('SELECT "teamCreationPolicy", "revision" FROM "HomeGovernancePolicy"')).toEqual([{ teamCreationPolicy: "managed_only", revision: 1 }]);
            expect(await query('SELECT "defaultSessionHistoryAccess", "admissionMode" FROM "Team" WHERE "id"=\'a\'')).toEqual([{ defaultSessionHistoryAccess: "from_membership", admissionMode: "invite_only" }]);
            await expect(exec(`INSERT INTO "TeamMembership" ("id","teamId","accountId","role") VALUES ('duplicate','a','active','member')`)).rejects.toThrow();
            await expect(exec(`INSERT INTO "TeamGroupMembership" ("teamId","teamGroupId","teamMembershipId") VALUES ('a','design','mb')`)).rejects.toThrow();
            await expect(exec(`INSERT INTO "TeamGroup" ("id","teamId","name","nameKey","updatedAt") VALUES ('duplicate','a','design','design',CURRENT_TIMESTAMP)`)).rejects.toThrow();
            expect((await query(`SELECT "id" FROM "TeamGroup" WHERE "teamId"='a' ORDER BY "nameKey","id"`)).map((row) => String(row.id))).toEqual(
                ["design", "resume-plain", "resume-accent"],
            );
            expect((await query(`SELECT "id" FROM "TeamGroup" WHERE "teamId"='a' AND ("nameKey" > 'resume' OR ("nameKey" = 'resume' AND "id" > 'resume-plain')) ORDER BY "nameKey","id"`)).map((row) => String(row.id))).toEqual(
                ["resume-accent"],
            );
            await expect(exec(`UPDATE "Account" SET "status"='unknown' WHERE "id"='active'`)).rejects.toThrow();
            await expect(exec(`UPDATE "TeamMembership" SET "role"='unknown' WHERE "id"='ma'`)).rejects.toThrow();
            await expect(exec(`INSERT INTO "TeamExternalGroupBinding" ("id","teamId","teamGroupId","externalGroupId","bindingMode") VALUES ('none','a','design','external','native_target')`)).rejects.toThrow();
            await expect(exec(`INSERT INTO "TeamExternalGroupBinding" ("id","teamId","teamGroupId","directorySourceId","teamIdentityConnectionId","externalGroupId","bindingMode") VALUES ('both','a','design','directory','connection','external','native_target')`)).rejects.toThrow();
            await exec(`INSERT INTO "TeamGroup" ("id","teamId","name","nameKey","updatedAt") VALUES ('other','a','Other','other',CURRENT_TIMESTAMP);
                INSERT INTO "TeamExternalGroupBinding" ("id","teamId","teamGroupId","directorySourceId","externalGroupId","bindingMode") VALUES ('binding','a','design','directory','external','native_target'),('other-binding','a','other','directory','other','native_target');
                INSERT INTO "TeamGroupMembershipExternalContribution" ("teamGroupId","teamMembershipId","externalGroupBindingId") VALUES ('design','ma','binding');`);
            await expect(exec(`INSERT INTO "TeamGroupMembershipExternalContribution" ("teamGroupId","teamMembershipId","externalGroupBindingId") VALUES ('design','ma','other-binding')`)).rejects.toThrow();
            await expect(exec(`DELETE FROM "TeamExternalGroupBinding" WHERE "id"='binding'`)).rejects.toThrow();
            const digestHex = "01".repeat(32);
            const tokenHash = sqlite ? `X'${digestHex}'` : `decode('${digestHex}','hex')`;
            await exec(`INSERT INTO "TeamInvitation" ("id","teamId","tokenHash","role","historyAccess","createdByAccountId","acceptedByAccountId","expiresAt") VALUES ('invitation','a',${tokenHash},'guest','from_membership','suspended','suspended',CURRENT_TIMESTAMP)`);
            await expect(exec(`INSERT INTO "TeamInvitation" ("id","teamId","tokenHash","role","historyAccess","expiresAt") VALUES ('duplicate','a',${tokenHash},'member','all_existing',CURRENT_TIMESTAMP)`)).rejects.toThrow();
            await exec(`DELETE FROM "Account" WHERE "id"='suspended'`);
            expect(await query(`SELECT "createdByAccountId","acceptedByAccountId" FROM "TeamInvitation" WHERE "id"='invitation'`)).toEqual([{ createdByAccountId: null, acceptedByAccountId: null }]);
            await exec(`UPDATE "TeamMembership" SET "accountId"='lookalike' WHERE "id"='ma'`);
            expect(await query('SELECT "teamMembershipId" FROM "TeamGroupMembership"')).toEqual([{ teamMembershipId: "ma" }]);
            await exec(`DELETE FROM "TeamMembership" WHERE "id"='ma'`);
            expect(await query('SELECT "teamMembershipId" FROM "TeamGroupMembership"')).toEqual([]);
            expect(await query('SELECT "teamMembershipId" FROM "TeamGroupMembershipExternalContribution"')).toEqual([]);
            if (sqlite) {
                expect(await query("PRAGMA foreign_key_check")).toEqual([]);
                expect(await query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
            }
        } finally {
            sqlite?.close();
            await postgres?.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
