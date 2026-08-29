import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applySqliteMigrations } from "../prismaMigrations";

const serverRoot = join(import.meta.dirname, "..", "..");
const sqliteMigrationsRoot = join(serverRoot, "prisma", "sqlite", "migrations");

const predecessorMigrationIds = [
    "20260216143000_connected_services_quota_snapshots",
    "20260807120000_add_session_unread_since",
    "20260808120000_add_session_needs_attention",
] as const;
const directoryMigrationId = "20260830120000_add_account_directory_models";

async function copyMigration(sourceId: string, targetRoot: string): Promise<void> {
    const targetDir = join(targetRoot, sourceId);
    await mkdir(targetDir, { recursive: true });
    await writeFile(
        join(targetDir, "migration.sql"),
        await readFile(join(sqliteMigrationsRoot, sourceId, "migration.sql"), "utf8"),
        "utf8",
    );
}

describe("SQLite 0.2 migration lineage before Account Directory", () => {
    const temporaryPaths: string[] = [];

    afterEach(async () => {
        await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it("keeps unreadSince, needsAttention, and its lookup index after a complete predecessor ledger", async () => {
        const migrationsDir = await mkdtemp(join(tmpdir(), "happier-account-directory-lineage-migrations-"));
        temporaryPaths.push(migrationsDir);
        await Promise.all(predecessorMigrationIds.map((id) => copyMigration(id, migrationsDir)));

        // This is the one 0.2 quota migration that was intentionally contracted from 0.3. Keep it
        // in the predecessor fixture so the test exercises a copied 0.2 ledger, while the 0.3
        // migration set remains free of the destructive quota transition.
        const quotaDropId = "20260630223000_drop_service_account_quota_snapshots";
        const quotaDropDir = join(migrationsDir, quotaDropId);
        await mkdir(quotaDropDir, { recursive: true });
        await writeFile(join(quotaDropDir, "migration.sql"), 'DROP TABLE IF EXISTS "ServiceAccountQuotaSnapshot";\n', "utf8");

        const dataDir = await mkdtemp(join(tmpdir(), "happier-account-directory-lineage-db-"));
        temporaryPaths.push(dataDir);
        const databasePath = join(dataDir, "lineage.sqlite");
        const seed = new DatabaseSync(databasePath);
        try {
            seed.exec(`
                PRAGMA foreign_keys=ON;
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Session" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "accountId" TEXT NOT NULL,
                    "seq" INTEGER NOT NULL DEFAULT 0,
                    "lastViewedSessionSeq" INTEGER,
                    "latestTurnStatus" TEXT,
                    "pendingPermissionRequestCount" INTEGER NOT NULL DEFAULT 0,
                    "pendingUserActionRequestCount" INTEGER NOT NULL DEFAULT 0,
                    "meaningfulActivityAt" DATETIME,
                    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT "Session_accountId_fkey"
                        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
                );
            `);
        } finally {
            seed.close();
        }

        const predecessorResult = await applySqliteMigrations({ databasePath, migrationsDir });
        expect(predecessorResult.applied).toEqual([
            "20260216143000_connected_services_quota_snapshots",
            quotaDropId,
            "20260807120000_add_session_unread_since",
            "20260808120000_add_session_needs_attention",
        ]);

        await copyMigration(directoryMigrationId, migrationsDir);
        const deployResult = await applySqliteMigrations({ databasePath, migrationsDir });
        expect(deployResult.applied).toEqual([directoryMigrationId]);

        const deployed = new DatabaseSync(databasePath);
        try {
            const sessionSql = deployed
                .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'Session'")
                .get() as { sql?: string } | undefined;
            expect(sessionSql?.sql).toContain('"unreadSince"');
            expect(sessionSql?.sql).toContain('"needsAttention"');
            expect(
                deployed
                    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
                    .get("Session_accountId_needsAttention_meaningfulActivityAt_id_idx"),
            ).toEqual({ name: "Session_accountId_needsAttention_meaningfulActivityAt_id_idx" });
            expect(
                deployed
                    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
                    .get("AccountHomeDirectoryEntry"),
            ).toEqual({ name: "AccountHomeDirectoryEntry" });
        } finally {
            deployed.close();
        }
    });
});
