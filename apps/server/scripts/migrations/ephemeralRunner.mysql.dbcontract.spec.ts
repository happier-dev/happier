import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/mysql-client/index.js";
import { splitMigrationStatements } from "../../sources/migrations/missingMigrationReconciliation";

const url = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
    ?? (process.env.HAPPIER_DB_PROVIDER === "mysql" ? process.env.DATABASE_URL : undefined);
const migrationNames = [
    "20260906153000_add_ephemeral_runner_activation",
    "20260906160000_add_ephemeral_runner_endpoint_facts",
    "20260906200000_add_machine_kind",
    "20260908110000_complete_ephemeral_runner_materialization",
] as const;

describe("ephemeral Runner MySQL persistence", () => {
    (url ? it : it.skip)("preserves reservations, defaults, JSON materialization, and explicit creator cleanup", async () => {
        const admin = new PrismaClient({ datasourceUrl: url });
        const databaseName = `runner_${randomUUID().replace(/-/gu, "")}`;
        const isolatedUrl = new URL(url!);
        isolatedUrl.pathname = `/${databaseName}`;
        const db = new PrismaClient({ datasourceUrl: isolatedUrl.toString() });

        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await db.$executeRawUnsafe(`
                CREATE TABLE \`Account\` (
                    \`id\` VARCHAR(191) NOT NULL PRIMARY KEY,
                    \`publicKey\` VARCHAR(191) NOT NULL,
                    \`updatedAt\` DATETIME(3) NOT NULL
                ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            `);
            await db.$executeRawUnsafe(`
                CREATE TABLE \`Machine\` (
                    \`id\` VARCHAR(191) NOT NULL PRIMARY KEY,
                    \`accountId\` VARCHAR(191) NOT NULL,
                    \`metadata\` TEXT NOT NULL,
                    \`updatedAt\` DATETIME(3) NOT NULL,
                    CONSTRAINT \`Machine_accountId_fkey\` FOREIGN KEY (\`accountId\`) REFERENCES \`Account\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
                ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            `);
            await db.$executeRawUnsafe("INSERT INTO `Account` (`id`,`publicKey`,`updatedAt`) VALUES ('activation-account','activation-account',CURRENT_TIMESTAMP(3)),('machine-account','machine-account',CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe("INSERT INTO `Machine` (`id`,`accountId`,`metadata`,`updatedAt`) VALUES ('preexisting-machine','machine-account','{}',CURRENT_TIMESTAMP(3))");

            const migrationRoot = join(import.meta.dirname, "../../prisma/mysql/migrations");
            for (const name of migrationNames) {
                const sql = await readFile(join(migrationRoot, name, "migration.sql"), "utf8");
                for (const statement of splitMigrationStatements(sql)) {
                    await db.$executeRawUnsafe(statement);
                }
            }

            expect(await db.$queryRawUnsafe("SELECT `kind` FROM `Machine` WHERE `id`='preexisting-machine'"))
                .toEqual([{ kind: "persistent" }]);
            await db.$executeRawUnsafe("INSERT INTO `Machine` (`id`,`accountId`,`metadata`,`kind`,`runnerContentKeyBinding`,`updatedAt`) VALUES ('runner-machine','machine-account','{}','ephemeral_session_runner',JSON_OBJECT('v',1),CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe(`
                INSERT INTO \`EphemeralRunnerActivation\` (
                    \`id\`,\`creatorAccountId\`,\`creatorTokenEpoch\`,\`draftId\`,\`sessionId\`,\`machineId\`,\`state\`,
                    \`progressPhase\`,\`workspacePolicy\`,
                    \`homeServerIdentityId\`,\`activationSigningPublicKey\`,\`authoringCommitment\`,\`artifact\`,
                    \`endpointFactsRecipient\`,\`authenticationEvidence\`,\`claim\`,\`endpointFacts\`,\`credentialSelection\`,\`review\`,\`consent\`,\`readiness\`,
                    \`sealedBootstrap\`,\`updatedAt\`
                ) VALUES (
                    'activation','activation-account',7,'draft','reserved-session','reserved-machine','materialized',
                    'creating_session','choose_on_endpoint',
                    'home','public-key','commitment',JSON_OBJECT('v',1),JSON_OBJECT('v',1),JSON_OBJECT('v',1),JSON_OBJECT('v',1),
                    JSON_OBJECT('v',1),JSON_OBJECT('v',1),JSON_OBJECT('v',1),JSON_OBJECT('v',1),JSON_OBJECT('v',1),JSON_OBJECT('v',1),CURRENT_TIMESTAMP(3)
                )
            `);
            expect(await db.$queryRawUnsafe("SELECT `progressPhase` FROM `EphemeralRunnerActivation` WHERE `id`='activation'"))
                .toEqual([{ progressPhase: "creating_session" }]);

            await expect(db.$executeRawUnsafe(`
                INSERT INTO \`EphemeralRunnerActivation\` (
                    \`id\`,\`creatorAccountId\`,\`creatorTokenEpoch\`,\`draftId\`,\`sessionId\`,\`machineId\`,\`state\`,
                    \`homeServerIdentityId\`,\`activationSigningPublicKey\`,\`authoringCommitment\`,\`artifact\`,
                    \`endpointFactsRecipient\`,\`workspacePolicy\`,\`updatedAt\`
                ) VALUES ('duplicate','activation-account',7,'draft-2','reserved-session','other-machine','pending','home','key','commitment',JSON_OBJECT(),JSON_OBJECT(),'choose_on_endpoint',CURRENT_TIMESTAMP(3))
            `)).rejects.toMatchObject({ code: "P2010", meta: { code: "1062" } });

            const jsonColumns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string; IS_NULLABLE: string; DATA_TYPE: string }>>(`
                SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME IN ('Machine', 'EphemeralRunnerActivation')
                  AND COLUMN_NAME IN ('runnerContentKeyBinding','artifact','endpointFactsRecipient','authenticationEvidence','claim','endpointFacts','credentialSelection','review','consent','readiness','sealedBootstrap')
                ORDER BY COLUMN_NAME
            `);
            expect(jsonColumns).toHaveLength(11);
            expect(jsonColumns.every((column) => column.DATA_TYPE === "json")).toBe(true);
            expect(jsonColumns.filter((column) => ["artifact", "endpointFactsRecipient"].includes(column.COLUMN_NAME)))
                .toEqual([
                    { COLUMN_NAME: "artifact", IS_NULLABLE: "NO", DATA_TYPE: "json" },
                    { COLUMN_NAME: "endpointFactsRecipient", IS_NULLABLE: "NO", DATA_TYPE: "json" },
                ]);
            expect(jsonColumns.filter((column) => !["artifact", "endpointFactsRecipient"].includes(column.COLUMN_NAME))
                .every((column) => column.IS_NULLABLE === "YES"))
                .toBe(true);

            const [progressPhaseColumn] = await db.$queryRawUnsafe<Array<{ IS_NULLABLE: string; DATA_TYPE: string }>>(`
                SELECT IS_NULLABLE, DATA_TYPE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'EphemeralRunnerActivation'
                  AND COLUMN_NAME = 'progressPhase'
            `);
            expect(progressPhaseColumn).toEqual({ IS_NULLABLE: "YES", DATA_TYPE: "varchar" });

            const identifiers = await db.$queryRawUnsafe<Array<{ name: string }>>(`
                SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'EphemeralRunnerActivation'
                UNION ALL
                SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'EphemeralRunnerActivation'
            `);
            expect(identifiers.filter(({ name }) => name.length > 64)).toEqual([]);

            await expect(db.$executeRawUnsafe("DELETE FROM `Account` WHERE `id`='activation-account'"))
                .rejects.toThrow();
            expect(await db.$queryRawUnsafe("SELECT `id` FROM `EphemeralRunnerActivation`"))
                .toEqual([{ id: "activation" }]);
            await db.$executeRawUnsafe("DELETE FROM `EphemeralRunnerActivation` WHERE `id`='activation'");
            await db.$executeRawUnsafe("DELETE FROM `Account` WHERE `id`='activation-account'");
            expect(await db.$queryRawUnsafe("SELECT `kind` FROM `Machine` ORDER BY `id`")).toEqual([
                { kind: "persistent" },
                { kind: "ephemeral_session_runner" },
            ]);
        } finally {
            await db.$disconnect();
            await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
            await admin.$disconnect();
        }
    });
});
