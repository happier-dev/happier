import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPrismaMigrateCli } from "../prismaMigrateCli";
import { createDbMaintenanceClient } from "../../sources/storage/prisma";

const databaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
const serverRoot = join(import.meta.dirname, "../..");
const migrationNames = [
    "20260202164738_baseline",
    "20260905220000_add_team_home_governance",
    "20260906210000_add_managed_identity_providers",
] as const;

describe("managed identity provider MySQL exact identity", () => {
    (databaseUrl ? it : it.skip)("keeps trailing-space directory identities distinct under NO PAD collation", async () => {
        const databaseName = `managed_identity_${randomUUID().replaceAll("-", "")}`;
        const isolatedUrl = new URL(databaseUrl!);
        isolatedUrl.pathname = `/${databaseName}`;
        const admin = await createDbMaintenanceClient("mysql", databaseUrl);
        const db = await createDbMaintenanceClient("mysql", isolatedUrl.toString());
        const stage = await mkdtemp(join(tmpdir(), "happier-managed-identity-mysql-"));
        const sourceRoot = join(serverRoot, "prisma/mysql");
        const deploy = () => runPrismaMigrateCli({
            serverRoot,
            schemaPath: join(stage, "schema.prisma"), args: ['deploy'],
            env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
            quiet: true,
        });
        let created = false;
        try {
            await admin.$executeRawUnsafe(
                `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
            );
            created = true;
            await copyFile(join(sourceRoot, "schema.prisma"), join(stage, "schema.prisma"));
            await mkdir(join(stage, "migrations"), { recursive: true });
            await writeFile(join(stage, "migrations/migration_lock.toml"), 'provider = "mysql"\n');
            for (const migrationName of migrationNames) {
                await mkdir(join(stage, "migrations", migrationName), { recursive: true });
                await copyFile(
                    join(sourceRoot, "migrations", migrationName, "migration.sql"),
                    join(stage, "migrations", migrationName, "migration.sql"),
                );
            }
            await deploy();
            const ledger = await db.$queryRawUnsafe(
                "SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name",
            );
            await deploy();
            expect(await db.$queryRawUnsafe(
                "SELECT migration_name,checksum FROM _prisma_migrations ORDER BY migration_name",
            )).toEqual(ledger);

            await db.$executeRawUnsafe(
                "INSERT INTO `Account` (`id`,`publicKey`,`updatedAt`) VALUES ('owner','owner',CURRENT_TIMESTAMP(3))",
            );
            await db.$executeRawUnsafe(
                "INSERT INTO `Team` (`id`,`name`,`updatedAt`) VALUES ('team','Exact Team',CURRENT_TIMESTAMP(3))",
            );
            await db.$executeRawUnsafe(
                "INSERT INTO `TeamMembership` (`id`,`teamId`,`accountId`,`role`) VALUES ('membership','team','owner','owner')",
            );
            await db.$executeRawUnsafe(
                "INSERT INTO `IdentityProviderInstance` (`id`,`ownerTeamId`,`kind`,`displayName`,`config`,`updatedAt`) VALUES ('provider','team','workos_sso','WorkOS','{}',CURRENT_TIMESTAMP(3))",
            );
            await db.$executeRawUnsafe(
                "INSERT INTO `TeamIdentityConnection` (`id`,`teamId`,`providerInstanceId`,`externalReference`,`settings`,`updatedAt`) VALUES ('connection','team','provider','{}','{}',CURRENT_TIMESTAMP(3))",
            );
            await db.$executeRawUnsafe(
                "INSERT INTO `TeamDirectorySource` (`id`,`teamId`,`kind`,`displayName`,`externalSourceKey`,`bindingConfig`,`teamIdentityConnectionId`,`updatedAt`) VALUES ('source','team','workos_directory','Directory','source','{}','connection',CURRENT_TIMESTAMP(3))",
            );
            await db.$executeRawUnsafe(`INSERT INTO \`TeamProvisionedIdentity\`
                (\`id\`,\`directorySourceId\`,\`teamId\`,\`externalUserId\`,\`externalSubjectId\`,\`state\`,\`teamMembershipId\`,\`teamMembershipTeamId\`,\`updatedAt\`) VALUES
                ('user-linked','source','team','linked-subject','linked-idp','active','membership','team',CURRENT_TIMESTAMP(3))`);
            await expect(db.$executeRawUnsafe(`INSERT INTO \`TeamProvisionedIdentity\`
                (\`id\`,\`directorySourceId\`,\`teamId\`,\`externalUserId\`,\`externalSubjectId\`,\`state\`,\`teamMembershipId\`,\`teamMembershipTeamId\`,\`updatedAt\`) VALUES
                ('user-partial','source','team','partial-subject','partial-idp','active','membership',NULL,CURRENT_TIMESTAMP(3))`))
                .rejects.toThrow();
            await expect(db.$executeRawUnsafe(`INSERT INTO \`TeamProvisionedIdentity\`
                (\`id\`,\`directorySourceId\`,\`teamId\`,\`externalUserId\`,\`externalSubjectId\`,\`state\`,\`teamMembershipId\`,\`teamMembershipTeamId\`,\`updatedAt\`) VALUES
                ('user-mismatched','source','team','mismatched-subject','mismatched-idp','active','membership','other-team',CURRENT_TIMESTAMP(3))`))
                .rejects.toThrow();
            await db.$executeRawUnsafe("DELETE FROM `TeamMembership` WHERE `id`='membership'");
            expect(await db.$queryRawUnsafe(
                "SELECT `teamMembershipId`,`teamMembershipTeamId` FROM `TeamProvisionedIdentity` WHERE `id`='user-linked'",
            )).toEqual([{ teamMembershipId: null, teamMembershipTeamId: null }]);
            await db.$executeRawUnsafe(`INSERT INTO \`TeamProvisionedIdentity\`
                (\`id\`,\`directorySourceId\`,\`teamId\`,\`externalUserId\`,\`externalSubjectId\`,\`state\`,\`updatedAt\`) VALUES
                ('user-plain','source','team','subject','idp','active',CURRENT_TIMESTAMP(3)),
                ('user-space','source','team','subject ','idp ','active',CURRENT_TIMESTAMP(3))`);
            await db.$executeRawUnsafe(`INSERT INTO \`TeamDirectoryGroup\`
                (\`id\`,\`directorySourceId\`,\`externalGroupId\`,\`externalDisplayName\`,\`state\`,\`updatedAt\`) VALUES
                ('group-plain','source','group','Group','active',CURRENT_TIMESTAMP(3)),
                ('group-space','source','group ','Group with space','active',CURRENT_TIMESTAMP(3))`);
            await db.$executeRawUnsafe(`INSERT INTO \`TeamDirectoryGroupMember\`
                (\`directorySourceId\`,\`externalGroupId\`,\`externalUserId\`) VALUES
                ('source','group','subject'),
                ('source','group ','subject ')`);

            expect(await db.$queryRawUnsafe(
                "SELECT `id` FROM `TeamProvisionedIdentity` WHERE `directorySourceId`='source' AND `externalUserId`='subject'",
            )).toEqual([{ id: "user-plain" }]);
            expect(await db.$queryRawUnsafe(
                "SELECT `id` FROM `TeamProvisionedIdentity` WHERE `directorySourceId`='source' AND `externalUserId`='subject '",
            )).toEqual([{ id: "user-space" }]);
            expect(await db.$queryRawUnsafe(
                "SELECT `id` FROM `TeamDirectoryGroup` WHERE `directorySourceId`='source' AND `externalGroupId`='group'",
            )).toEqual([{ id: "group-plain" }]);
            expect(await db.$queryRawUnsafe(
                "SELECT `id` FROM `TeamDirectoryGroup` WHERE `directorySourceId`='source' AND `externalGroupId`='group '",
            )).toEqual([{ id: "group-space" }]);

            const exactColumns = await db.$queryRawUnsafe<Array<{
                TABLE_NAME: string;
                COLUMN_NAME: string;
                COLLATION_NAME: string;
                PAD_ATTRIBUTE: string;
            }>>(`SELECT c.TABLE_NAME,c.COLUMN_NAME,c.COLLATION_NAME,co.PAD_ATTRIBUTE
                FROM information_schema.COLUMNS c
                JOIN information_schema.COLLATIONS co ON co.COLLATION_NAME=c.COLLATION_NAME
                WHERE c.TABLE_SCHEMA=DATABASE() AND (
                    (c.TABLE_NAME='GitHubAppRegistration' AND c.COLUMN_NAME='githubHost') OR
                    (c.TABLE_NAME='TeamDirectorySource' AND c.COLUMN_NAME IN ('externalSourceKey','eventCursor')) OR
                    (c.TABLE_NAME='TeamProvisionedIdentity' AND c.COLUMN_NAME IN ('externalUserId','externalSubjectId')) OR
                    (c.TABLE_NAME='TeamProvisionedIdentity' AND c.COLUMN_NAME='lastSeenReconcileRunId') OR
                    (c.TABLE_NAME='TeamDirectoryGroup' AND c.COLUMN_NAME='externalGroupId') OR
                    (c.TABLE_NAME='TeamDirectoryGroup' AND c.COLUMN_NAME='lastSeenReconcileRunId') OR
                    (c.TABLE_NAME='TeamDirectoryGroupMember' AND c.COLUMN_NAME IN ('externalGroupId','externalUserId')) OR
                    (c.TABLE_NAME='TeamDirectoryGroupMember' AND c.COLUMN_NAME='lastSeenReconcileRunId') OR
                    (c.TABLE_NAME='TeamExternalGroupBinding' AND c.COLUMN_NAME='externalGroupId')
                ) ORDER BY c.TABLE_NAME,c.COLUMN_NAME`);
            expect(exactColumns).toHaveLength(12);
            expect(exactColumns.every((column) =>
                column.COLLATION_NAME === "utf8mb4_0900_bin" && column.PAD_ATTRIBUTE === "NO PAD"))
                .toBe(true);
            expect(await db.$queryRawUnsafe(
                "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('TeamProvisionedIdentity','TeamDirectoryGroup','TeamDirectoryGroupMember') ORDER BY TABLE_NAME",
            )).toEqual([
                { TABLE_NAME: "TeamDirectoryGroup" },
                { TABLE_NAME: "TeamDirectoryGroupMember" },
                { TABLE_NAME: "TeamProvisionedIdentity" },
            ]);
        } finally {
            await db.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP DATABASE \`${databaseName}\``);
            await admin.$disconnect();
            await rm(stage, { recursive: true, force: true });
        }
    }, 120_000);
});
