import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260825130000_add_automation_account_settings_and_run_compaction";

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

describe("automation Run compaction schema", () => {
    it("preserves the strict live Conversation handoff arm while allowing only compacted reply payloads", async () => {
        const [postgresSql, mysqlSql, sqliteSql] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
        ]);

        expect(postgresSql).toMatch(
            /ALTER\s+TABLE\s+"AutomationRun"\s+DROP\s+CONSTRAINT\s+"AutomationRun_reply_handoff_arm_check"\s*;[\s\S]*?ADD\s+CONSTRAINT\s+"AutomationRun_reply_handoff_arm_check"/i,
        );
        expect(mysqlSql).toMatch(
            /ALTER\s+TABLE\s+`AutomationRun`\s+DROP\s+CHECK\s+`AutomationRun_reply_handoff_arm_check`\s*;[\s\S]*?ADD\s+CONSTRAINT\s+`AutomationRun_reply_handoff_arm_check`/i,
        );
        expect(sqliteSql).toMatch(
            /PRAGMA\s+defer_foreign_keys\s*=\s*ON\s*;[\s\S]*?CREATE\s+TABLE\s+"new_AutomationRun"[\s\S]*?DROP\s+TABLE\s+"AutomationRun"/i,
        );

        for (const [sql, quoted] of [
            [postgresSql, '"'] as const,
            [mysqlSql, "`"] as const,
            [sqliteSql, '"'] as const,
        ]) {
            const field = (name: string) => `${quoted}${name}${quoted}`;
            const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            // Active handoffs remain unchanged: a Conversation still needs its
            // reply context and identity fields unless retention has explicitly
            // marked its payload as removed.
            expect(sql).toMatch(new RegExp(
                `${escaped(field("originKind"))}\\s*=\\s*'conversation'[\\s\\S]{0,300}`
                + `${escaped(field("replyContextEnvelope"))}\\s+IS\\s+NOT\\s+NULL[\\s\\S]{0,700}`
                + `${escaped(field("replyHandoffId"))}\\s+IS\\s+NOT\\s+NULL`,
                "i",
            ));
            expect(sql).toMatch(new RegExp(
                `${escaped(field("originKind"))}\\s*=\\s*'conversation'[\\s\\S]{0,300}`
                + `${escaped(field("contentRemovedAt"))}\\s+IS\\s+NOT\\s+NULL[\\s\\S]{0,500}`
                + `${escaped(field("replyContextEnvelope"))}\\s+IS\\s+NULL[\\s\\S]{0,500}`
                + `${escaped(field("replyHandoffActionPluginId"))}\\s+IS\\s+NOT\\s+NULL[\\s\\S]{0,900}`
                + `${escaped(field("replyHandoffId"))}\\s+IS\\s+NOT\\s+NULL[\\s\\S]{0,500}`
                + `${escaped(field("replyHandoffReceiptEnvelope"))}\\s+IS\\s+NULL`,
                "i",
            ));
        }
    });

    it("keeps PostgreSQL Conversation handoffs strict until the retention owner removes their payload", async () => {
        const db = new PGlite();
        try {
            await db.exec(`
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "AutomationRun" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "originKind" TEXT NOT NULL,
                    "replyContextEnvelope" TEXT,
                    "replyHandoffActionPluginId" TEXT,
                    "replyHandoffActionLocalId" TEXT,
                    "replyHandoffTargetMachineId" TEXT,
                    "replyHandoffTargetMachineInstallationId" TEXT,
                    "replyHandoffTargetMaterializationId" TEXT,
                    "replyHandoffId" TEXT,
                    "replyHandoffState" TEXT NOT NULL DEFAULT 'none',
                    "replyHandoffAttempt" INTEGER NOT NULL DEFAULT 0,
                    "replyHandoffDueAt" TIMESTAMP(3),
                    "replyHandoffReceiptEnvelope" TEXT,
                    CONSTRAINT "AutomationRun_reply_handoff_arm_check"
                        CHECK (
                            (
                                "originKind" = 'conversation'
                                AND "replyContextEnvelope" IS NOT NULL
                                AND "replyHandoffActionPluginId" IS NOT NULL
                                AND "replyHandoffActionLocalId" IS NOT NULL
                                AND "replyHandoffTargetMachineId" IS NOT NULL
                                AND "replyHandoffTargetMachineInstallationId" IS NOT NULL
                                AND "replyHandoffTargetMaterializationId" IS NOT NULL
                                AND "replyHandoffId" IS NOT NULL
                                AND "replyHandoffState" <> 'none'
                            )
                            OR
                            (
                                "originKind" IN ('scheduled', 'manual', 'pluginEvent', 'conversation')
                                AND "replyContextEnvelope" IS NULL
                                AND "replyHandoffActionPluginId" IS NULL
                                AND "replyHandoffActionLocalId" IS NULL
                                AND "replyHandoffTargetMachineId" IS NULL
                                AND "replyHandoffTargetMachineInstallationId" IS NULL
                                AND "replyHandoffTargetMaterializationId" IS NULL
                                AND "replyHandoffId" IS NULL
                                AND "replyHandoffState" = 'none'
                                AND "replyHandoffAttempt" = 0
                                AND "replyHandoffDueAt" IS NULL
                                AND "replyHandoffReceiptEnvelope" IS NULL
                            )
                        )
                );
            `);
            await db.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));

            await db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "originKind", "replyContextEnvelope",
                    "replyHandoffActionPluginId", "replyHandoffActionLocalId",
                    "replyHandoffTargetMachineId", "replyHandoffTargetMachineInstallationId",
                    "replyHandoffTargetMaterializationId", "replyHandoffId", "replyHandoffState",
                    "replyHandoffReceiptEnvelope"
                ) VALUES (
                    'compacted-conversation', 'conversation', 'private reply context',
                    'plugin', 'action', 'machine', 'installation', 'materialization', 'handoff', 'accepted',
                    'private receipt'
                );
                UPDATE "AutomationRun"
                SET
                    "contentRemovedAt" = CURRENT_TIMESTAMP,
                    "replyContextEnvelope" = NULL,
                    "replyHandoffReceiptEnvelope" = NULL
                WHERE "id" = 'compacted-conversation';
            `);

            await expect(db.exec(`
                UPDATE "AutomationRun"
                SET "contentRemovedAt" = NULL
                WHERE "id" = 'compacted-conversation';
            `)).rejects.toThrow();
            await expect(db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "originKind", "contentRemovedAt", "replyHandoffState"
                ) VALUES ('missing-handoff-identity', 'conversation', CURRENT_TIMESTAMP, 'accepted');
            `)).rejects.toThrow();
        } finally {
            await db.close();
        }
    });
});
