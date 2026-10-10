import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { applySqliteMigrations } from "../prismaMigrations";

const migrationName = "20261009170000_home_identity_connection_scope";
const migrationsDir = join(import.meta.dirname, "../../prisma/sqlite/migrations");

describe("Home identity connection scope migration", () => {
    it("retains populated bindings and every inbound composite reference, matching a fresh deploy", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happier-home-identity-scope-"));
        const priorMigrations = join(directory, "prior");
        const databasePath = join(directory, "upgrade.sqlite");
        const freshPath = join(directory, "fresh.sqlite");
        await mkdir(priorMigrations);
        try {
            for (const name of (await readdir(migrationsDir)).sort()) {
                if (name >= migrationName || name === "migration_lock.toml") continue;
                await mkdir(join(priorMigrations, name));
                await writeFile(join(priorMigrations, name, "migration.sql"), await readFile(join(migrationsDir, name, "migration.sql")));
            }
            await applySqliteMigrations({ databasePath, migrationsDir: priorMigrations });
            const seed = new DatabaseSync(databasePath);
            const referencedTables = ["TeamIdentityConnection", "TeamMembershipIdentityConnectionManagement", "TeamDirectorySource", "TeamExternalGroupBinding"];
            let before: unknown[];
            try {
                seed.exec("PRAGMA foreign_keys=ON");
                const inbound = seed.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
                    .filter((row) => seed.prepare(`PRAGMA foreign_key_list("${row.name}")`).all().some((fk) => fk.table === "TeamIdentityConnection"))
                    .map((row) => row.name).sort();
                expect(inbound).toEqual(referencedTables.slice(1).sort());
                seed.exec(`
                    INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES ('actor', 'actor', CURRENT_TIMESTAMP);
                    INSERT INTO "Team" ("id", "name", "updatedAt") VALUES ('team', 'Company', CURRENT_TIMESTAMP);
                    INSERT INTO "TeamMembership" ("id", "teamId", "accountId", "role") VALUES ('member', 'team', 'actor', 'owner');
                    INSERT INTO "TeamGroup" ("id", "teamId", "name", "nameKey", "updatedAt") VALUES ('group', 'team', 'Company', 'company', CURRENT_TIMESTAMP);
                    INSERT INTO "IdentityProviderInstance" ("id", "ownerTeamId", "kind", "displayName", "config", "updatedAt")
                        VALUES ('provider', 'team', 'workos_sso', 'Company', '{"v":1,"kind":"workos_sso"}', CURRENT_TIMESTAMP);
                    INSERT INTO "TeamIdentityConnection" ("id", "teamId", "providerInstanceId", "externalReference", "settings", "enabled", "revision", "updatedAt")
                        VALUES ('binding', 'team', 'provider', '{"v":1,"kind":"workos_sso","organizationId":"org","connectionId":"sso"}', '{"v":1,"kind":"workos_sso"}', 1, 3, CURRENT_TIMESTAMP);
                    INSERT INTO "TeamMembershipIdentityConnectionManagement" ("teamMembershipId", "teamId", "teamIdentityConnectionId") VALUES ('member', 'team', 'binding');
                    INSERT INTO "TeamDirectorySource" ("id", "teamId", "kind", "displayName", "externalSourceKey", "bindingConfig", "teamIdentityConnectionId", "updatedAt")
                        VALUES ('directory', 'team', 'workos_directory', 'Company', 'workos:directory', '{"v":1,"kind":"workos_directory","workosDirectoryId":"directory"}', 'binding', CURRENT_TIMESTAMP);
                    INSERT INTO "TeamExternalGroupBinding" ("id", "teamId", "teamGroupId", "teamIdentityConnectionId", "externalGroupId", "bindingMode")
                        VALUES ('group-binding', 'team', 'group', 'binding', 'external-group', 'native_target');
                `);
                expect(seed.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
                before = referencedTables.map((table) => seed.prepare(`SELECT * FROM "${table}"`).all());
            } finally {
                seed.close();
            }
            await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toMatchObject({ applied: expect.arrayContaining([migrationName]) });
            await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [] });
            await applySqliteMigrations({ databasePath: freshPath, migrationsDir });
            const upgraded = new DatabaseSync(databasePath);
            const fresh = new DatabaseSync(freshPath);
            try {
                expect(referencedTables.map((table) => upgraded.prepare(`SELECT * FROM "${table}"`).all())).toEqual(before!);
                expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
                expect(upgraded.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
                const schema = (db: DatabaseSync) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
                expect(schema(upgraded)).toEqual(schema(fresh));
                upgraded.exec(`INSERT INTO "IdentityProviderInstance" ("id", "kind", "displayName", "config", "updatedAt") VALUES ('home-provider', 'workos_sso', 'Home company', '{"v":1,"kind":"workos_sso"}', CURRENT_TIMESTAMP);
                    INSERT INTO "TeamIdentityConnection" ("id", "providerInstanceId", "externalReference", "settings", "updatedAt") VALUES ('home-binding', 'home-provider', '{"v":1,"kind":"workos_sso","organizationId":"home-org","connectionId":"home-sso"}', '{"v":1,"kind":"workos_sso"}', CURRENT_TIMESTAMP);`);
                expect(upgraded.prepare('SELECT "teamId" FROM "TeamIdentityConnection" WHERE "id" = ?').get('home-binding')).toEqual({ teamId: null });
                upgraded.exec("PRAGMA foreign_keys=ON");
                expect(() => upgraded.exec(`UPDATE "TeamDirectorySource" SET "teamIdentityConnectionId"='home-binding' WHERE "id"='directory'`)).toThrow(/FOREIGN KEY/);
                expect(() => upgraded.exec(`DELETE FROM "TeamIdentityConnection" WHERE "id"='binding'`)).toThrow(/FOREIGN KEY/);
            } finally {
                upgraded.close();
                fresh.close();
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
