import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/sqlite-client/index.js";
import { applySqliteMigrations } from "../prismaMigrations";

const removedMigrationName = "20260814160000_add_session_message_attention_impact";
// Exact checksum recorded by the retained development SQLite database before source contraction.
const removedMigrationChecksum = "4d6edc7212bc92f2cfe73e9ceaa8a283b03bee1a28a817999cc88c2a0d85097b";
const migrationsDir = join(import.meta.dirname, "..", "..", "prisma", "sqlite", "migrations");

describe("removed SessionMessage attention-impact migration compatibility", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it("accepts a retained extra ledger row, nullable columns, CHECK, and index", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "happier-removed-attention-migration-"));
        tempDirs.push(tempDir);
        const databasePath = join(tempDir, "compat.sqlite");

        const initialMigrationResult = await applySqliteMigrations({ databasePath, migrationsDir });
        expect(initialMigrationResult.applied.length).toBeGreaterThan(0);
        expect(initialMigrationResult.applied).not.toContain(removedMigrationName);

        const seed = new DatabaseSync(databasePath);
        try {
            seed.exec(`
                ALTER TABLE "SessionMessage" ADD COLUMN "attentionAffectsUnread" BOOLEAN;
                ALTER TABLE "SessionMessage" ADD COLUMN "attentionAffectsMeaningfulActivity" BOOLEAN
                    CHECK (("attentionAffectsUnread" IS NULL AND "attentionAffectsMeaningfulActivity" IS NULL)
                        OR ("attentionAffectsUnread" IS NOT NULL AND "attentionAffectsMeaningfulActivity" IS NOT NULL));
                CREATE INDEX "SessionMessage_attention_unread_seq_idx"
                    ON "SessionMessage"("sessionId", "sidechainId", "attentionAffectsUnread", "seq");
            `);
            seed.prepare(`
                INSERT INTO "_prisma_migrations"
                    ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
                VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)
            `).run("retained-development-migration", removedMigrationChecksum, removedMigrationName);
            expect(() => seed.prepare(`
                INSERT INTO "SessionMessage" (
                    "id", "sessionId", "seq", "content", "updatedAt",
                    "attentionAffectsUnread", "attentionAffectsMeaningfulActivity"
                ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
            `).run("invalid-attention-pair", "unused-session", 0, "{}", 1, null)).toThrow(
                /CHECK constraint failed/i,
            );
        } finally {
            seed.close();
        }

        await expect(applySqliteMigrations({ databasePath, migrationsDir })).resolves.toEqual({ applied: [] });

        const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
        try {
            const account = await prisma.account.create({
                data: { publicKey: "removed-attention-migration-account" },
                select: { id: true },
            });
            const session = await prisma.session.create({
                data: {
                    accountId: account.id,
                    tag: "removed-attention-migration-session",
                    metadata: "{}",
                },
                select: { id: true },
            });
            const message = await prisma.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq: 1,
                    content: { t: "encrypted", c: "compatibility-probe" },
                },
                select: { id: true },
            });

            await expect(prisma.$queryRawUnsafe(`
                SELECT "attentionAffectsUnread", "attentionAffectsMeaningfulActivity"
                FROM "SessionMessage" WHERE "id" = ?
            `, message.id)).resolves.toEqual([{
                attentionAffectsUnread: null,
                attentionAffectsMeaningfulActivity: null,
            }]);
            await prisma.$executeRawUnsafe(`
                UPDATE "SessionMessage"
                SET "attentionAffectsUnread" = 1, "attentionAffectsMeaningfulActivity" = 1
                WHERE "id" = ?
            `, message.id);

            await expect(prisma.sessionMessage.update({
                where: { id: message.id },
                data: { seq: 2, rowRevision: { increment: 1 } },
                select: { seq: true, rowRevision: true },
            })).resolves.toEqual({ seq: 2, rowRevision: 1n });
            await expect(prisma.$queryRawUnsafe(`
                SELECT CAST("attentionAffectsUnread" AS INTEGER) AS "attentionAffectsUnread",
                    CAST("attentionAffectsMeaningfulActivity" AS INTEGER) AS "attentionAffectsMeaningfulActivity"
                FROM "SessionMessage" WHERE "id" = ?
            `, message.id)).resolves.toEqual([{
                attentionAffectsUnread: 1n,
                attentionAffectsMeaningfulActivity: 1n,
            }]);
            await expect(prisma.$queryRawUnsafe(`
                SELECT "migration_name" FROM "_prisma_migrations" WHERE "id" = ?
            `, "retained-development-migration")).resolves.toEqual([{
                migration_name: removedMigrationName,
            }]);
            await expect(prisma.$queryRawUnsafe(`
                SELECT "name" FROM sqlite_schema
                WHERE type = 'index' AND name = 'SessionMessage_attention_unread_seq_idx'
            `)).resolves.toEqual([{
                name: "SessionMessage_attention_unread_seq_idx",
            }]);
        } finally {
            await prisma.$disconnect();
        }
    });
});
