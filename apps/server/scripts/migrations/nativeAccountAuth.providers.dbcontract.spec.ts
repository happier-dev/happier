import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitMigrationStatements } from "../../sources/migrations/missingMigrationReconciliation";
import { normalizeVerifiedEmail } from "../../../../packages/protocol/src/auth/verifiedEmail";
import { createDbMaintenanceClient } from "../../sources/storage/prisma";

const url = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
    ?? (process.env.HAPPIER_DB_PROVIDER === "mysql" ? process.env.DATABASE_URL : undefined);

describe("native Account auth MySQL migration", () => {
    (url ? it : it.skip)("widens released subjects without losing uniqueness and stores full-length mailbox keys", async () => {
        const admin = await createDbMaintenanceClient("mysql", url);
        const databaseName = `native_auth_${randomUUID().replace(/-/gu, "")}`;
        const isolatedUrl = new URL(url!);
        isolatedUrl.pathname = `/${databaseName}`;
        const db = await createDbMaintenanceClient("mysql", isolatedUrl.toString());
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await db.$executeRawUnsafe("CREATE TABLE `Account` (`id` VARCHAR(191) NOT NULL PRIMARY KEY) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            await db.$executeRawUnsafe("CREATE TABLE `AccountEncryptionTransition` (`id` VARCHAR(36) NOT NULL PRIMARY KEY) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            // The consolidated unreleased auth-hardening migration extends the
            // existing terminal request lifecycle before creating the Lane 02
            // tables. This isolated predecessor must include that real owner,
            // otherwise a configured MySQL gate fails before reaching the
            // native-auth migration it is intended to verify.
            await db.$executeRawUnsafe("CREATE TABLE `TerminalAuthRequest` (`id` VARCHAR(191) NOT NULL PRIMARY KEY) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            const migrationRoot = join(import.meta.dirname, "../../prisma/mysql/migrations");
            // Immutable server-v0.2.11/preview.2 @98ea8fb: exercise the actual short-column predecessor.
            for (const statement of splitMigrationStatements(await readFile(join(migrationRoot, "20260205103927_add_account_identity/migration.sql"), "utf8"))) await db.$executeRawUnsafe(statement);
            for (const statement of splitMigrationStatements(await readFile(join(migrationRoot, "20260822150000_auth_hardening_and_api_tokens/migration.sql"), "utf8"))) await db.$executeRawUnsafe(statement);
            await db.$executeRawUnsafe("INSERT INTO `Account` (`id`) VALUES ('one'), ('two'), ('three'), ('four')");
            await db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('external','one','github','preserved-subject',CURRENT_TIMESTAMP(3))");
            for (const statement of splitMigrationStatements(await readFile(join(migrationRoot, "20260905210000_add_native_account_auth/migration.sql"), "utf8"))) await db.$executeRawUnsafe(statement);
            const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}`;
            expect(email.length).toBe(320);
            const opaqueSubject = "S".repeat(512);
            const providerLogin = "l".repeat(320);
            await db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('native','one','email',?,CURRENT_TIMESTAMP(3))", email);
            await db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`providerLogin`,`updatedAt`) VALUES ('workos','three','workos',?,?,CURRENT_TIMESTAMP(3))", opaqueSubject,providerLogin);
            await db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('exact-no-space','two','oidc','subject',CURRENT_TIMESTAMP(3))");
            await db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('exact-trailing-space','four','oidc','subject ',CURRENT_TIMESTAMP(3))");
            await expect(db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('collision','two','email',?,CURRENT_TIMESTAMP(3))", email)).rejects.toThrow();
            await db.$executeRawUnsafe("INSERT INTO `AccountEmail` (`accountId`,`address`,`normalizedEmail`) VALUES ('one',?,?),('two',?,?)", email,email,email,email);
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountIdentity` WHERE `provider`='email' AND `providerUserId`=?",email)).toEqual([{accountId:"one"}]);
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountIdentity` WHERE `provider`='workos' AND `providerUserId`=?",opaqueSubject)).toEqual([{accountId:"three"}]);
            expect(await db.$queryRawUnsafe("SELECT `providerLogin` FROM `AccountIdentity` WHERE `id`='workos'")).toEqual([{providerLogin}]);
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountIdentity` WHERE `provider`='oidc' AND `providerUserId`='subject'")).toEqual([{accountId:"two"}]);
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountIdentity` WHERE `provider`='oidc' AND `providerUserId`='subject '")).toEqual([{accountId:"four"}]);
            expect(await db.$queryRawUnsafe(`SELECT c.COLLATION_NAME AS collation, co.PAD_ATTRIBUTE AS padAttribute
                FROM information_schema.COLUMNS c
                JOIN information_schema.COLLATIONS co ON co.COLLATION_NAME=c.COLLATION_NAME
                WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME='AccountIdentity' AND c.COLUMN_NAME='providerUserId'`))
                .toEqual([{ collation: "utf8mb4_0900_bin", padAttribute: "NO PAD" }]);
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountEmail` WHERE `normalizedEmail`=? ORDER BY `accountId`",email)).toEqual([{accountId:"one"},{accountId:"two"}]);
            const changedEmail = `z${email.slice(1)}`;
            await db.$executeRawUnsafe("UPDATE `AccountIdentity` SET `providerUserId`=? WHERE `id`='native'",changedEmail);
            expect(await db.$queryRawUnsafe("SELECT `providerUserId` FROM `AccountIdentity` WHERE `id`='native'")).toEqual([{providerUserId:changedEmail}]);
            expect(await db.$queryRawUnsafe("SELECT `providerUserId` FROM `AccountIdentity` WHERE `id`='external'")).toEqual([{providerUserId:"preserved-subject"}]);
            // Native mailbox equality is the protocol normalizer's exact output.
            const unaccented = normalizeVerifiedEmail("jose@example.com")!.normalizedEmail;
            const accented = normalizeVerifiedEmail("josé@example.com")!.normalizedEmail;
            expect(unaccented).not.toBe(accented);
            await db.$executeRawUnsafe("UPDATE `AccountIdentity` SET `providerUserId`=? WHERE `id`='native'", unaccented);
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountIdentity` WHERE `provider`='email' AND `providerUserId`=?", accented)).toEqual([]);
            await db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('accented','two','email',?,CURRENT_TIMESTAMP(3))", accented);
            // External opaque subjects are exact too (OIDC Core section 2).
            // Widening must retain the old row without making case variants aliases.
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountIdentity` WHERE `provider`='github' AND `providerUserId`='PRESERVED-SUBJECT'")).toEqual([]);
            await db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('external-case','two','github','PRESERVED-SUBJECT',CURRENT_TIMESTAMP(3))");
            await expect(db.$executeRawUnsafe("INSERT INTO `AccountIdentity` (`id`,`accountId`,`provider`,`providerUserId`,`updatedAt`) VALUES ('external-duplicate','three','github','preserved-subject',CURRENT_TIMESTAMP(3))")).rejects.toThrow();
            await db.$executeRawUnsafe("INSERT INTO `AccountPasswordCredential` (`accountId`,`credential`) VALUES ('one','{}')");
            await db.$executeRawUnsafe("DELETE FROM `Account` WHERE `id`='one'");
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountPasswordCredential`")).toEqual([]);
            expect(await db.$queryRawUnsafe("SELECT `accountId` FROM `AccountEmail`")).toEqual([{accountId:"two"}]);
        } finally {
            await db.$disconnect();
            await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
            await admin.$disconnect();
        }
    });
});
