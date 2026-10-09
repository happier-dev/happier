import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/mysql-client/index.js";
import { splitMigrationStatements } from "../../sources/migrations/missingMigrationReconciliation";

// Never use DATABASE_URL: only the dedicated test boundary permits creating
// and removing the isolated database used by this real-provider contract.
const testDatabaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL?.trim();
const mysqlTest = testDatabaseUrl ? it : it.skip;
const migrations = join(import.meta.dirname, "../../prisma/mysql/migrations");

describe("requester Machine AccessKey MySQL migration", () => {
    mysqlTest("preserves predecessor rows, tuple uniqueness and independent Account/Machine/Session references", async () => {
        const databaseName = `requester_access_key_${randomUUID().replaceAll("-", "")}`;
        const admin = new PrismaClient({ datasourceUrl: testDatabaseUrl });
        const targetUrl = new URL(testDatabaseUrl!);
        targetUrl.pathname = `/${databaseName}`;
        const database = new PrismaClient({ datasourceUrl: targetUrl.toString() });
        const execute = async (sql: string) => {
            for (const statement of splitMigrationStatements(sql)) await database.$executeRawUnsafe(statement);
        };
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\``);
            await execute(await readFile(join(migrations, "20260202164738_baseline/migration.sql"), "utf8"));
            await execute(`
                INSERT INTO Account (id,publicKey,updatedAt) VALUES ('alice','alice',CURRENT_TIMESTAMP(3)),('bob','bob',CURRENT_TIMESTAMP(3));
                INSERT INTO Machine (id,accountId,metadata,updatedAt) VALUES ('alice-machine','alice','{}',CURRENT_TIMESTAMP(3));
                INSERT INTO Session (id,accountId,tag,metadata,updatedAt) VALUES ('alice-session','alice','alice-session','{}',CURRENT_TIMESTAMP(3)),('bob-session','bob','bob-session','{}',CURRENT_TIMESTAMP(3));
                INSERT INTO AccessKey (id,accountId,machineId,sessionId,data,dataVersion,createdAt,updatedAt) VALUES ('old-key','alice','alice-machine','alice-session','opaque-predecessor',7,'2026-01-01 12:00:00','2026-01-02 12:00:00');
            `);
            const before = await database.$queryRawUnsafe("SELECT * FROM AccessKey");
            await execute(await readFile(join(migrations, "20261008130000_requester_machine_access_key_binding/migration.sql"), "utf8"));
            expect(await database.$queryRawUnsafe("SELECT * FROM AccessKey")).toEqual(before);
            const insert = (id: string, accountId = "bob", machineId = "alice-machine", sessionId = "bob-session") => database.$executeRaw`
                INSERT INTO AccessKey (id,accountId,machineId,sessionId,data,dataVersion,updatedAt)
                VALUES (${id},${accountId},${machineId},${sessionId},'opaque-requester',9,CURRENT_TIMESTAMP(3))`;
            await insert("new-key");
            expect(await database.$queryRawUnsafe("SELECT accountId,machineId,sessionId,dataVersion FROM AccessKey WHERE id='new-key'"))
                .toEqual([{ accountId: "bob", machineId: "alice-machine", sessionId: "bob-session", dataVersion: 9 }]);
            await expect(insert("duplicate")).rejects.toThrow();
            await expect(insert("missing-account", "missing")).rejects.toThrow();
            await expect(insert("missing-machine", "bob", "missing")).rejects.toThrow();
            await expect(insert("missing-session", "bob", "alice-machine", "missing")).rejects.toThrow();
            await expect(database.$executeRawUnsafe("DELETE FROM Machine WHERE id='alice-machine'")).rejects.toThrow();
            await expect(database.$executeRawUnsafe("DELETE FROM Session WHERE id='bob-session'")).rejects.toThrow();
            await database.$executeRawUnsafe("DELETE FROM AccessKey WHERE machineId='alice-machine'");
            expect(await database.$queryRawUnsafe("SELECT id FROM Session ORDER BY id"))
                .toEqual([{ id: "alice-session" }, { id: "bob-session" }]);
        } finally {
            await database.$disconnect();
            await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
            await admin.$disconnect();
        }
    }, 120_000);
});
