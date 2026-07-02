import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readText(path: string): string {
    return readFileSync(path, "utf-8");
}

function listMigrationSqlFiles(migrationsDir: string): string[] {
    const entries = readdirSync(migrationsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(migrationsDir, e.name, "migration.sql"));
    return entries;
}

function anyFileContains(paths: string[], patterns: string[]): boolean {
    for (const p of paths) {
        let text = "";
        try {
            text = readText(p);
        } catch {
            continue;
        }
        if (patterns.every((pat) => text.includes(pat))) {
            return true;
        }
    }
    return false;
}

function expectNoFileContains(paths: string[], pattern: string): void {
    for (const p of paths) {
        let text = "";
        try {
            text = readText(p);
        } catch {
            continue;
        }
        expect(text, `${p} must not contain ${pattern}`).not.toContain(pattern);
    }
}

describe("migrations (provider completeness)", () => {
    it("includes AccountChange entity FK columns across providers", () => {
        const root = process.cwd();
        const schema = readText(join(root, "prisma", "schema.prisma"));
        expect(schema).toContain("sessionId");
        expect(schema).toContain("machineId");
        expect(schema).toContain("artifactId");

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "AccountChange" ADD COLUMN',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "AccountChange"',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `AccountChange`",
                "`sessionId`",
                "`machineId`",
                "`artifactId`",
            ]),
        ).toBe(true);
    });

    it("includes AccountPushToken.clientServerUrl across providers", () => {
        const root = process.cwd();
        expect(readText(join(root, "prisma", "schema.prisma"))).toContain("clientServerUrl String?");
        expect(readText(join(root, "prisma", "sqlite", "schema.prisma"))).toContain("clientServerUrl String?");
        expect(readText(join(root, "prisma", "mysql", "schema.prisma"))).toContain("clientServerUrl String?");

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "AccountPushToken" ADD COLUMN',
                '"clientServerUrl"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'ALTER TABLE "AccountPushToken" ADD COLUMN',
                '"clientServerUrl"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "ALTER TABLE `AccountPushToken` ADD COLUMN",
                "`clientServerUrl`",
            ]),
        ).toBe(true);
    });

    it("backfills Session.meaningfulActivityAt from pending rows across providers", () => {
        const root = process.cwd();

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt"',
                'FROM "SessionPendingMessage"',
                'MAX("createdAt")',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt"',
                'FROM "SessionPendingMessage"',
                'MAX("createdAt")',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "ALTER TABLE `Session` ADD COLUMN `meaningfulActivityAt`",
                "FROM `SessionPendingMessage`",
                "MAX(`createdAt`)",
            ]),
        ).toBe(true);
    });

    it("stores SessionTurn runtime issues and mutation receipts with the v2 durable contract across providers", () => {
        const root = process.cwd();
        for (const schemaPath of [
            join(root, "prisma", "schema.prisma"),
            join(root, "prisma", "sqlite", "schema.prisma"),
            join(root, "prisma", "mysql", "schema.prisma"),
        ]) {
            const schema = readText(schemaPath);
            expect(schema).toContain("lastRuntimeIssueJson");
            expect(schema).toContain("providerRollbackOrdinal Int?");
            expect(schema).not.toContain("rollbackProviderOrdinal");
            expect(schema).toContain("decision   String");
            expect(schema).toContain("observedAt BigInt");
            expect(schema).toContain("appliedAt  BigInt");
            expect(schema).toContain("@@index([sessionId, status])");
            expect(schema).toContain("@@index([sessionId, rollbackState])");
            expect(schema).toContain("@@index([sessionId, provider, providerTurnId])");
            expect(schema).toContain("@@index([sessionId, appliedAt])");
        }

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expectNoFileContains(pgFiles, "rollbackProviderOrdinal");
        expect(
            anyFileContains(pgFiles, [
                'CREATE TABLE "SessionTurn"',
                '"lastRuntimeIssueJson"',
                '"providerRollbackOrdinal"',
                'CREATE INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"',
            ]),
        ).toBe(true);
        expect(
            anyFileContains(pgFiles, [
                'CREATE TABLE "SessionTurnMutationReceipt"',
                '"decision" TEXT NOT NULL',
                '"observedAt" BIGINT NOT NULL',
                '"appliedAt" BIGINT NOT NULL',
                'CREATE INDEX "SessionTurnMutationReceipt_sessionId_appliedAt_idx"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expectNoFileContains(sqliteFiles, "rollbackProviderOrdinal");
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "SessionTurn"',
                '"lastRuntimeIssueJson"',
                '"providerRollbackOrdinal"',
                'CREATE INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"',
            ]),
        ).toBe(true);
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "SessionTurnMutationReceipt"',
                '"decision" TEXT NOT NULL',
                '"observedAt" BIGINT NOT NULL',
                '"appliedAt" BIGINT NOT NULL',
                'CREATE INDEX "SessionTurnMutationReceipt_sessionId_appliedAt_idx"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expectNoFileContains(mysqlFiles, "rollbackProviderOrdinal");
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `SessionTurn`",
                "`lastRuntimeIssueJson`",
                "`providerRollbackOrdinal`",
                "CREATE INDEX `SessionTurn_sessionId_provider_providerTurnId_idx`",
            ]),
        ).toBe(true);
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `SessionTurnMutationReceipt`",
                "`decision` VARCHAR(191) NOT NULL",
                "`observedAt` BIGINT NOT NULL",
                "`appliedAt` BIGINT NOT NULL",
                "CREATE INDEX `SessionTurnMutationReceipt_sessionId_appliedAt_idx`",
            ]),
        ).toBe(true);
    });

    it("uses the remote-dev SessionTurn migration identity across providers", () => {
        const root = process.cwd();
        for (const providerPath of [
            join(root, "prisma"),
            join(root, "prisma", "sqlite"),
            join(root, "prisma", "mysql"),
        ]) {
            expect(
                existsSync(join(providerPath, "migrations", "20260517190000_add_session_turns", "migration.sql")),
                providerPath,
            ).toBe(true);
            expect(
                existsSync(join(providerPath, "migrations", "20260521133000_add_session_turn_rows", "migration.sql")),
                providerPath,
            ).toBe(false);
        }
    });

    it("does not ship primary turn projection state schema artifacts", () => {
        const root = process.cwd();
        for (const schemaPath of [
            join(root, "prisma", "schema.prisma"),
            join(root, "prisma", "sqlite", "schema.prisma"),
            join(root, "prisma", "mysql", "schema.prisma"),
        ]) {
            expect(readText(schemaPath), schemaPath).not.toContain("primaryTurnProjectionStateJson");
        }

        for (const providerPath of [
            join(root, "prisma"),
            join(root, "prisma", "sqlite"),
            join(root, "prisma", "mysql"),
        ]) {
            expect(
                existsSync(join(providerPath, "migrations", "20260517190000_add_primary_turn_projection_state", "migration.sql")),
                providerPath,
            ).toBe(false);
            expectNoFileContains(listMigrationSqlFiles(join(providerPath, "migrations")), "primaryTurnProjectionStateJson");
        }
    });
});
