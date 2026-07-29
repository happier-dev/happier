import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationName = "20260729102000_add_voice_conversation_grant_provenance";

function readMigration(provider: "postgres" | "sqlite" | "mysql"): string {
    const providerSegments = provider === "postgres" ? [] : [provider];
    return readFileSync(
        join(process.cwd(), "prisma", ...providerSegments, "migrations", migrationName, "migration.sql"),
        "utf8",
    );
}

describe("VoiceConversation grant-provenance migration", () => {
    let postgres: PGlite | null = null;

    afterEach(async () => {
        await postgres?.close();
        postgres = null;
    });

    it.each([
        ["postgres", `CREATE FUNCTION "preserveVoiceConversationGrantBeforeLeaseDelete"`, `UPDATE "VoiceConversation" AS conversation`],
        ["sqlite", `CREATE TRIGGER "VoiceSessionLease_preserve_conversation_grant"`, `UPDATE "VoiceConversation"\nSET "grantedBy"`],
        ["mysql", "CREATE TRIGGER `VoiceSessionLease_preserve_conversation_grant`", "UPDATE `VoiceConversation` AS conversation"],
    ] as const)("installs the %s rolling-delete adapter before the potentially long backfill", (provider, triggerMarker, backfillMarker) => {
        const migration = readMigration(provider);
        expect(migration.indexOf(triggerMarker)).toBeGreaterThanOrEqual(0);
        expect(migration.indexOf(backfillMarker)).toBeGreaterThanOrEqual(0);
        expect(migration.indexOf(triggerMarker)).toBeLessThan(migration.indexOf(backfillMarker));
    });

    it("backfills exact known lease grants and preserves pruned legacy rows as unknown on SQLite", () => {
        const sqlite = new DatabaseSync(":memory:");
        try {
            sqlite.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE "VoiceSessionLease" (
                    "id" TEXT PRIMARY KEY,
                    "grantedBy" TEXT NOT NULL,
                    "periodKey" TEXT NOT NULL
                );
                CREATE TABLE "VoiceConversation" (
                    "id" TEXT PRIMARY KEY,
                    "leaseId" TEXT,
                    FOREIGN KEY ("leaseId") REFERENCES "VoiceSessionLease"("id") ON DELETE SET NULL
                );
                INSERT INTO "VoiceSessionLease" ("id", "grantedBy", "periodKey")
                VALUES
                    ('lease-free', 'free', '2026-07'),
                    ('lease-subscription', 'subscription', '2026-07');
                INSERT INTO "VoiceConversation" ("id", "leaseId")
                VALUES
                    ('conversation-free', 'lease-free'),
                    ('conversation-subscription', 'lease-subscription'),
                    ('conversation-pruned', NULL);
            `);

            sqlite.exec(readMigration("sqlite"));
            sqlite.exec(`
                -- Simulate an older completion writer and cleanup worker that remain live
                -- after the additive migration has landed.
                INSERT INTO "VoiceSessionLease" ("id", "grantedBy", "periodKey")
                VALUES
                    ('rolling-free', 'free', '2026-08'),
                    ('rolling-subscription', 'subscription', '2026-08');
                INSERT INTO "VoiceConversation" ("id", "leaseId")
                VALUES
                    ('conversation-rolling-free', 'rolling-free'),
                    ('conversation-rolling-subscription', 'rolling-subscription');
                DELETE FROM "VoiceSessionLease"
                WHERE "id" IN ('rolling-free', 'rolling-subscription');
            `);

            expect(
                sqlite.prepare(`
                    SELECT "id", "leaseId", "grantedBy", "grantPeriodKey"
                    FROM "VoiceConversation"
                    ORDER BY "id"
                `).all(),
            ).toEqual([
                { id: "conversation-free", leaseId: "lease-free", grantedBy: "free", grantPeriodKey: "2026-07" },
                { id: "conversation-pruned", leaseId: null, grantedBy: null, grantPeriodKey: null },
                { id: "conversation-rolling-free", leaseId: null, grantedBy: "free", grantPeriodKey: "2026-08" },
                { id: "conversation-rolling-subscription", leaseId: null, grantedBy: "subscription", grantPeriodKey: "2026-08" },
                { id: "conversation-subscription", leaseId: "lease-subscription", grantedBy: "subscription", grantPeriodKey: "2026-07" },
            ]);
            const grantedByColumn = sqlite
                .prepare(`PRAGMA table_info("VoiceConversation")`)
                .all()
                .find((column) => column.name === "grantedBy");
            expect(grantedByColumn).toMatchObject({ notnull: 0 });
        } finally {
            sqlite.close();
        }
    });

    it("backfills exact known lease grants and preserves pruned legacy rows as unknown on PostgreSQL", async () => {
        postgres = new PGlite();
        await postgres.exec(`
            CREATE TABLE "VoiceSessionLease" (
                "id" TEXT PRIMARY KEY,
                "grantedBy" TEXT NOT NULL,
                "periodKey" TEXT NOT NULL
            );
            CREATE TABLE "VoiceConversation" (
                "id" TEXT PRIMARY KEY,
                "leaseId" TEXT REFERENCES "VoiceSessionLease"("id") ON DELETE SET NULL
            );
            INSERT INTO "VoiceSessionLease" ("id", "grantedBy", "periodKey")
            VALUES
                ('lease-free', 'free', '2026-07'),
                ('lease-subscription', 'subscription', '2026-07');
            INSERT INTO "VoiceConversation" ("id", "leaseId")
            VALUES
                ('conversation-free', 'lease-free'),
                ('conversation-subscription', 'lease-subscription'),
                ('conversation-pruned', NULL);
        `);

        await postgres.exec(readMigration("postgres"));
        await postgres.exec(`
            -- Simulate an older completion writer and cleanup worker that remain live
            -- after the additive migration has landed.
            INSERT INTO "VoiceSessionLease" ("id", "grantedBy", "periodKey")
            VALUES
                ('rolling-free', 'free', '2026-08'),
                ('rolling-subscription', 'subscription', '2026-08');
            INSERT INTO "VoiceConversation" ("id", "leaseId")
            VALUES
                ('conversation-rolling-free', 'rolling-free'),
                ('conversation-rolling-subscription', 'rolling-subscription');
            DELETE FROM "VoiceSessionLease"
            WHERE "id" IN ('rolling-free', 'rolling-subscription');
        `);

        const result = await postgres.query<{
            id: string;
            leaseId: string | null;
            grantedBy: string | null;
            grantPeriodKey: string | null;
        }>(`
            SELECT "id", "leaseId", "grantedBy", "grantPeriodKey"
            FROM "VoiceConversation"
            ORDER BY "id"
        `);
        expect(result.rows).toEqual([
            { id: "conversation-free", leaseId: "lease-free", grantedBy: "free", grantPeriodKey: "2026-07" },
            { id: "conversation-pruned", leaseId: null, grantedBy: null, grantPeriodKey: null },
            { id: "conversation-rolling-free", leaseId: null, grantedBy: "free", grantPeriodKey: "2026-08" },
            { id: "conversation-rolling-subscription", leaseId: null, grantedBy: "subscription", grantPeriodKey: "2026-08" },
            { id: "conversation-subscription", leaseId: "lease-subscription", grantedBy: "subscription", grantPeriodKey: "2026-07" },
        ]);
    });

    it("preserves account-cascade deletion behavior with the SQLite compatibility trigger", () => {
        const sqlite = new DatabaseSync(":memory:");
        try {
            sqlite.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "VoiceSessionLease" (
                    "id" TEXT PRIMARY KEY,
                    "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
                    "grantedBy" TEXT NOT NULL,
                    "periodKey" TEXT NOT NULL
                );
                CREATE TABLE "VoiceConversation" (
                    "id" TEXT PRIMARY KEY,
                    "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
                    "leaseId" TEXT REFERENCES "VoiceSessionLease"("id") ON DELETE SET NULL
                );
                INSERT INTO "Account" ("id") VALUES ('account-cascade');
                INSERT INTO "VoiceSessionLease" ("id", "accountId", "grantedBy", "periodKey")
                VALUES ('lease-cascade', 'account-cascade', 'free', '2026-07');
                INSERT INTO "VoiceConversation" ("id", "accountId", "leaseId")
                VALUES ('conversation-cascade', 'account-cascade', 'lease-cascade');
            `);
            sqlite.exec(readMigration("sqlite"));

            sqlite.exec(`DELETE FROM "Account" WHERE "id" = 'account-cascade'`);

            expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "VoiceSessionLease"`).get()).toEqual({ count: 0 });
            expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM "VoiceConversation"`).get()).toEqual({ count: 0 });
        } finally {
            sqlite.close();
        }
    });

    it("preserves account-cascade deletion behavior with the PostgreSQL compatibility trigger", async () => {
        postgres = new PGlite();
        await postgres.exec(`
            CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
            CREATE TABLE "VoiceSessionLease" (
                "id" TEXT PRIMARY KEY,
                "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
                "grantedBy" TEXT NOT NULL,
                "periodKey" TEXT NOT NULL
            );
            CREATE TABLE "VoiceConversation" (
                "id" TEXT PRIMARY KEY,
                "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
                "leaseId" TEXT REFERENCES "VoiceSessionLease"("id") ON DELETE SET NULL
            );
            INSERT INTO "Account" ("id") VALUES ('account-cascade');
            INSERT INTO "VoiceSessionLease" ("id", "accountId", "grantedBy", "periodKey")
            VALUES ('lease-cascade', 'account-cascade', 'free', '2026-07');
            INSERT INTO "VoiceConversation" ("id", "accountId", "leaseId")
            VALUES ('conversation-cascade', 'account-cascade', 'lease-cascade');
        `);
        await postgres.exec(readMigration("postgres"));

        await postgres.exec(`DELETE FROM "Account" WHERE "id" = 'account-cascade'`);

        const leaseCount = await postgres.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "VoiceSessionLease"`);
        const conversationCount = await postgres.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "VoiceConversation"`);
        expect(leaseCount.rows).toEqual([{ count: 0 }]);
        expect(conversationCount.rows).toEqual([{ count: 0 }]);
    });

    it("keeps the MySQL transition additive and backfills only from the existing lease owner", () => {
        const mysql = readMigration("mysql");
        expect(mysql).toContain("ADD COLUMN `grantedBy` VARCHAR(191) NULL");
        expect(mysql).toContain("ADD COLUMN `grantPeriodKey` VARCHAR(191) NULL");
        expect(mysql).toContain("INNER JOIN `VoiceSessionLease` AS lease");
        expect(mysql).toContain("SET conversation.`grantedBy` = COALESCE(conversation.`grantedBy`, lease.`grantedBy`)");
        expect(mysql).toContain("conversation.`grantPeriodKey` = COALESCE(conversation.`grantPeriodKey`, lease.`periodKey`)");
        expect(mysql).toContain("BEFORE DELETE ON `VoiceSessionLease`");
        expect(mysql).toContain("OLD.`grantedBy`");
        expect(mysql).toContain("OLD.`periodKey`");
        expect(mysql).not.toContain("NOT NULL");
        expect(mysql).not.toContain("DEFAULT");
    });
});
