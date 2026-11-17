import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPrismaMigrateCli } from "../prismaMigrateCli";
import { readTransactionDatabaseTime } from "../../sources/storage/transactionDatabaseTime";
import { createDbMaintenanceClient } from "../../sources/storage/prisma";

const databaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
const serverRoot = join(import.meta.dirname, "../..");
const migrationName = "20260905220000_add_team_home_governance";

describe("Team governance MySQL upgrade", () => {
    (databaseUrl ? it : it.skip)("preserves exact disablement, relational lifetimes and database-clock precision across two deploys", async () => {
        const databaseName = `teams_${randomUUID().replaceAll("-", "")}`;
        const isolatedUrl = new URL(databaseUrl!);
        isolatedUrl.pathname = `/${databaseName}`;
        const admin = await createDbMaintenanceClient("mysql", databaseUrl);
        const db = await createDbMaintenanceClient("mysql", isolatedUrl.toString());
        const stage = await mkdtemp(join(tmpdir(), "happier-teams-mysql-"));
        const sourceRoot = join(serverRoot, "prisma/mysql");
        const deploy = () => runPrismaMigrateCli({
            serverRoot,
            schemaPath: join(stage, "schema.prisma"), args: ['deploy'],
            env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
            quiet: true,
        });
        const stageMigration = async (name: string) => {
            await mkdir(join(stage, "migrations", name), { recursive: true });
            await copyFile(join(sourceRoot, "migrations", name, "migration.sql"), join(stage, "migrations", name, "migration.sql"));
        };
        let created = false;
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            created = true;
            await copyFile(join(sourceRoot, "schema.prisma"), join(stage, "schema.prisma"));
            // Retained immutable server-v0.2.11/preview.2 baseline; no reconstructed Account schema.
            await stageMigration("20260202164738_baseline");
            await writeFile(join(stage, "migrations/migration_lock.toml"), 'provider = "mysql"\n');
            await deploy();
            await db.$executeRawUnsafe("INSERT INTO `Account` (`id`,`publicKey`,`updatedAt`) VALUES ('active','active',CURRENT_TIMESTAMP(3)),('retired','retired',CURRENT_TIMESTAMP(3)),('expired','expired',CURRENT_TIMESTAMP(3)),('lookalike','lookalike',CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe("INSERT INTO `RepeatKey` (`key`,`value`,`expiresAt`) VALUES ('auth_disabled_retired','retired','2100-01-01'),('auth_disabled_expired','expired','2000-01-01'),('authXdisabledXlookalike','unrelated','2100-01-01'),('AUTH_DISABLED_active','unrelated','2100-01-01')");
            await stageMigration(migrationName);
            await deploy();
            expect(await db.$queryRawUnsafe("SELECT `id`,`homeRole`,`status` FROM `Account` ORDER BY `id`")).toEqual([
                { id: "active", homeRole: "member", status: "active" },
                { id: "expired", homeRole: "member", status: "active" },
                { id: "lookalike", homeRole: "member", status: "active" },
                { id: "retired", homeRole: "member", status: "disabled" },
            ]);
            expect(await db.$queryRawUnsafe("SELECT `key` FROM `RepeatKey` ORDER BY BINARY `key`")).toEqual([{ key: "AUTH_DISABLED_active" }, { key: "authXdisabledXlookalike" }]);
            expect(await db.$queryRawUnsafe(`SELECT CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='TeamGroup' AND COLUMN_NAME='nameKey'`)).toEqual([
                { characterSet: "utf8mb4", collation: "utf8mb4_bin" },
            ]);
            const ledger = await db.$queryRawUnsafe("SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name");
            await deploy();
            expect(await db.$queryRawUnsafe("SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name")).toEqual(ledger);
            await db.$executeRawUnsafe("INSERT INTO `Team` (`id`,`name`,`updatedAt`) VALUES ('a','Same',CURRENT_TIMESTAMP(3)),('b','Same',CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe("INSERT INTO `TeamMembership` (`id`,`teamId`,`accountId`,`role`) VALUES ('ma','a','active','owner'),('mb','b','expired','guest')");
            await db.$executeRawUnsafe(`INSERT INTO \`TeamGroup\` (\`id\`,\`teamId\`,\`name\`,\`nameKey\`,\`updatedAt\`) VALUES
                ('design','a','Design','design',CURRENT_TIMESTAMP(3)),
                ('resume-plain','a','Resume','resume',CURRENT_TIMESTAMP(3)),
                ('resume-accent','a','Résumé','résumé',CURRENT_TIMESTAMP(3))`);
            await expect(db.$executeRawUnsafe(
                "INSERT INTO `TeamGroup` (`id`,`teamId`,`name`,`nameKey`,`updatedAt`) VALUES ('case-duplicate','a','design','design',CURRENT_TIMESTAMP(3))",
            )).rejects.toThrow();
            expect((await db.$queryRawUnsafe<Array<{ id: string }>>(
                "SELECT `id` FROM `TeamGroup` WHERE `teamId`='a' ORDER BY `nameKey`,`id`",
            )).map((row) => row.id)).toEqual(["design", "resume-plain", "resume-accent"]);
            expect((await db.$queryRawUnsafe<Array<{ id: string }>>(
                "SELECT `id` FROM `TeamGroup` WHERE `teamId`='a' AND (`nameKey` > 'resume' OR (`nameKey` = 'resume' AND `id` > 'resume-plain')) ORDER BY `nameKey`,`id`",
            )).map((row) => row.id)).toEqual(["resume-accent"]);
            await expect(db.$executeRawUnsafe("INSERT INTO `TeamGroupMembership` (`teamId`,`teamGroupId`,`teamMembershipId`) VALUES ('a','design','mb')")).rejects.toThrow();
            await expect(db.$executeRawUnsafe("INSERT INTO `TeamExternalGroupBinding` (`id`,`teamId`,`teamGroupId`,`externalGroupId`,`bindingMode`) VALUES ('none','a','design','external','native_target')")).rejects.toThrow();
            await db.$executeRawUnsafe("INSERT INTO `TeamGroupMembership` (`teamId`,`teamGroupId`,`teamMembershipId`,`nativeContribution`) VALUES ('a','design','ma',true)");
            vi.stubEnv("HAPPIER_DB_PROVIDER", "mysql");
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2100-01-01T00:00:00Z"));
            await db.$transaction(async (tx) => {
                const time = await readTransactionDatabaseTime(tx);
                expect(time.getUTCFullYear()).toBeLessThan(2100);
                await tx.$executeRawUnsafe("UPDATE `TeamMembership` SET `sessionAccessStartsAt`=? WHERE `id`='ma'", time);
                const rows = await tx.$queryRawUnsafe<Array<{ sessionAccessStartsAt: Date }>>("SELECT `sessionAccessStartsAt` FROM `TeamMembership` WHERE `id`='ma'");
                expect(rows[0]?.sessionAccessStartsAt.getTime()).toBe(time.getTime());
            });
            vi.useRealTimers();
            await db.$executeRawUnsafe("UPDATE `TeamMembership` SET `accountId`='lookalike' WHERE `id`='ma'");
            expect(await db.$queryRawUnsafe("SELECT `teamMembershipId` FROM `TeamGroupMembership`")).toEqual([{ teamMembershipId: "ma" }]);
            await db.$executeRawUnsafe("DELETE FROM `TeamMembership` WHERE `id`='ma'");
            expect(await db.$queryRawUnsafe("SELECT `teamMembershipId` FROM `TeamGroupMembership`")).toEqual([]);
        } finally {
            vi.useRealTimers();
            vi.unstubAllEnvs();
            await db.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
            await admin.$disconnect();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);
});
