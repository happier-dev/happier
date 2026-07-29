import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { PGlite } from "@electric-sql/pglite";

import { applyPostgresMigrations, applySqliteMigrations } from "./prismaMigrations";

const execFileAsync = promisify(execFile);
const maxMysqlIdentifierLength = 64;

function repoRelativePath(repoRoot: string, path: string): string {
    return relative(repoRoot, path).split(sep).join("/");
}

async function createMigrationDir(prefix: string, migrations: ReadonlyArray<Readonly<{ name: string; sql: string }>>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    for (const migration of migrations) {
        const migrationDir = join(dir, migration.name);
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, "migration.sql"), migration.sql, "utf8");
    }
    return dir;
}

async function listMigrationSqlFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listMigrationSqlFiles(path));
        } else if (entry.isFile() && entry.name === "migration.sql") {
            files.push(path);
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

function readCreatedIndexOrConstraintIdentifiers(sql: string): string[] {
    const identifiers: string[] = [];
    const patterns = [
        /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]([^`"]+)[`"]/gi,
        /(?:^|[,\n]\s*)(?:UNIQUE\s+)?INDEX\s+[`"]([^`"]+)[`"]/gi,
        /\bCONSTRAINT\s+[`"]([^`"]+)[`"]/gi,
    ];

    for (const pattern of patterns) {
        for (const match of sql.matchAll(pattern)) {
            const identifier = match[1]?.trim();
            if (identifier) {
                identifiers.push(identifier);
            }
        }
    }

    return identifiers;
}

function readDroppedIndexIdentifiers(sql: string): string[] {
    const identifiers: string[] = [];
    const pattern = /\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?[`"]([^`"]+)[`"]/gi;
    for (const match of sql.matchAll(pattern)) {
        const identifier = match[1]?.trim();
        if (identifier) {
            identifiers.push(identifier);
        }
    }
    return identifiers;
}

function readRenamedIndexPairs(sql: string): Array<Readonly<{ from: string; to: string }>> {
    const pairs: Array<Readonly<{ from: string; to: string }>> = [];
    const patterns = [
        /\bALTER\s+INDEX\s+[`"]([^`"]+)[`"]\s+RENAME\s+TO\s+[`"]([^`"]+)[`"]/gi,
        /\bRENAME\s+INDEX\s+[`"]([^`"]+)[`"]\s+TO\s+[`"]([^`"]+)[`"]/gi,
    ];

    for (const pattern of patterns) {
        for (const match of sql.matchAll(pattern)) {
            const from = match[1]?.trim();
            const to = match[2]?.trim();
            if (from && to) {
                pairs.push(Object.freeze({ from, to }));
            }
        }
    }

    return pairs;
}

async function listMigrationPolicySqlFiles(repoRoot: string, migrationRoots: readonly string[]): Promise<string[]> {
    const files = await Promise.all(
        migrationRoots.map((migrationRoot) => listMigrationSqlFiles(join(repoRoot, migrationRoot))),
    );
    return files.flat().sort((left, right) => left.localeCompare(right));
}

describe("Prisma migration identifier hygiene", () => {
    it("selects migration files deterministically regardless of whether git tracks them", async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), "happier-migration-hygiene-git-state-"));
        const migrationRoot = "prisma/mysql/migrations";

        try {
            await execFileAsync("git", ["init", "--quiet"], { cwd: repoRoot });
            for (const migration of [
                { name: "20200102000000_second", sql: "SELECT 2;" },
                { name: "20200101000000_first", sql: "SELECT 1;" },
            ]) {
                const migrationDir = join(repoRoot, migrationRoot, migration.name);
                await mkdir(migrationDir, { recursive: true });
                await writeFile(join(migrationDir, "migration.sql"), migration.sql, "utf8");
            }

            const beforeStaging = await listMigrationPolicySqlFiles(repoRoot, [migrationRoot]);
            await execFileAsync("git", ["add", "--", migrationRoot], { cwd: repoRoot });
            const afterStaging = await listMigrationPolicySqlFiles(repoRoot, [migrationRoot]);
            await execFileAsync(
                "git",
                [
                    "-c",
                    "user.name=Migration Hygiene Test",
                    "-c",
                    "user.email=migration-hygiene@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "fixture",
                ],
                { cwd: repoRoot },
            );
            const afterCommit = await listMigrationPolicySqlFiles(repoRoot, [migrationRoot]);

            expect(beforeStaging.map((file) => file.slice(repoRoot.length + 1))).toEqual([
                "prisma/mysql/migrations/20200101000000_first/migration.sql",
                "prisma/mysql/migrations/20200102000000_second/migration.sql",
            ]);
            expect(afterStaging).toEqual(beforeStaging);
            expect(afterCommit).toEqual(beforeStaging);
        } finally {
            await rm(repoRoot, { recursive: true, force: true });
        }
    });

    it("enforces current migration identifier and collation hygiene", async () => {
        const repoRoot = join(__dirname, "../../..");
        const migrationRoots = [
            "apps/server/prisma/migrations",
            "apps/server/prisma/mysql/migrations",
            "apps/server/prisma/sqlite/migrations",
        ];
        const flavorDirs = migrationRoots.map((root) => join(repoRoot, root));
        const migrationPolicyFiles = new Set(await listMigrationPolicySqlFiles(repoRoot, migrationRoots));
        const createTimeViolations: string[] = [];
        const mysqlCollationViolations: string[] = [];
        const renameTargetViolations: string[] = [];
        const finalViolations: string[] = [];

        for (const file of migrationPolicyFiles) {
            const sql = await readFile(file, "utf8");
            const relativePath = repoRelativePath(repoRoot, file);

            if (relativePath.startsWith("apps/server/prisma/mysql/migrations/")) {
                const legacyIndexReferences = new Set([
                    ...readDroppedIndexIdentifiers(sql),
                    ...readRenamedIndexPairs(sql).map(({ from }) => from),
                ]);
                for (const identifier of readCreatedIndexOrConstraintIdentifiers(sql)) {
                    if (identifier.length > maxMysqlIdentifierLength) {
                        createTimeViolations.push(
                            `${basename(dirname(file))}/${basename(file)}:${identifier.length}:${identifier}`,
                        );
                    }
                }
                for (const match of sql.matchAll(/`([^`]+)`/g)) {
                    const identifier = match[1] ?? "";
                    if (
                        identifier.length > maxMysqlIdentifierLength
                        && !legacyIndexReferences.has(identifier)
                    ) {
                        createTimeViolations.push(
                            `${basename(dirname(file))}/${basename(file)}:${identifier.length}:${identifier}`,
                        );
                    }
                }
                for (const match of sql.matchAll(/CREATE TABLE\s+`[^`]+`\s*\([\s\S]*?\)\s*(?:DEFAULT[^;]+)?;/g)) {
                    const statement = match[0];
                    if (statement.includes("VARCHAR") && !/DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;/.test(statement)) {
                        mysqlCollationViolations.push(`${basename(dirname(file))}/${basename(file)}`);
                    }
                }
            }
        }

        for (const dir of flavorDirs) {
            const finalIndexes = new Set<string>();
            for (const file of await listMigrationSqlFiles(dir)) {
                const sql = await readFile(file, "utf8");
                for (const identifier of readDroppedIndexIdentifiers(sql)) {
                    finalIndexes.delete(identifier);
                }
                for (const pair of readRenamedIndexPairs(sql)) {
                    if (pair.to.length > maxMysqlIdentifierLength) {
                        renameTargetViolations.push(`${basename(dirname(file))}/${basename(file)}:${pair.to.length}:${pair.to}`);
                    }
                    finalIndexes.delete(pair.from);
                    finalIndexes.add(pair.to);
                }
                for (const identifier of readCreatedIndexOrConstraintIdentifiers(sql)) {
                    finalIndexes.add(identifier);
                }
            }

            for (const identifier of finalIndexes) {
                if (identifier.length > maxMysqlIdentifierLength) {
                    finalViolations.push(`${basename(dir)}:${identifier.length}:${identifier}`);
                }
            }
        }

        expect({
            createTimeViolations,
            mysqlCollationViolations,
            renameTargetViolations,
            finalViolations,
        }).toEqual({
            createTimeViolations: [],
            mysqlCollationViolations: [],
            renameTargetViolations: [],
            finalViolations: [],
        });
    });
});

describe("applySqliteMigrations", () => {
    it("upgrades the exact remote-dev SQLite migration lineage without rewriting applied checksums", async () => {
        const serverRoot = join(import.meta.dirname, "..");
        const predecessorMigrations = [
            {
                name: "20260517190000_add_session_turns",
                checksum: "0527a67d34b182b04439cb9000108d4a0275dd54769d2cb66924533753dca1ea",
            },
            {
                name: "20260630162000_add_provider_account_usage_records",
                checksum: "a7677b52c4e91a9018dd4b77435f8fa2dd09b68e074d67f3bd60cf041c4ab4d5",
            },
        ] as const;
        const correctionMigrationName = "20260725110000_reconcile_predecessor_migration_lineage";
        const migrations = await Promise.all([
            ...predecessorMigrations.map(async ({ name }) => ({
                name,
                sql: await readFile(
                    join(serverRoot, "prisma", "sqlite", "migrations", name, "migration.sql"),
                    "utf8",
                ),
            })),
            readFile(
                join(
                    serverRoot,
                    "prisma",
                    "sqlite",
                    "migrations",
                    correctionMigrationName,
                    "migration.sql",
                ),
                "utf8",
            ).then(
                (sql) => ({ name: correctionMigrationName, sql }),
                () => null,
            ),
        ]);
        const migrationsDir = await createMigrationDir(
            "happier-prisma-sqlite-predecessor-lineage-",
            migrations.filter((migration): migration is { name: string; sql: string } => migration !== null),
        );
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-predecessor-lineage-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                db.exec(`
                    CREATE TABLE "_prisma_migrations" (
                        "id" TEXT NOT NULL PRIMARY KEY,
                        "checksum" TEXT NOT NULL,
                        "finished_at" DATETIME,
                        "migration_name" TEXT NOT NULL,
                        "logs" TEXT,
                        "rolled_back_at" DATETIME,
                        "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE TABLE "SessionTurn" (
                        "id" TEXT NOT NULL PRIMARY KEY,
                        "sessionId" TEXT NOT NULL,
                        "provider" TEXT,
                        "providerTurnId" TEXT,
                        "providerRollbackOrdinal" INTEGER
                    );
                    CREATE INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"
                    ON "SessionTurn"("sessionId", "provider", "providerTurnId");
                    INSERT INTO "SessionTurn" (
                        "id", "sessionId", "provider", "providerTurnId", "providerRollbackOrdinal"
                    ) VALUES (
                        'turn-1', 'session-1', 'codex', 'provider-turn-1', 7
                    );
                    CREATE TABLE "ProviderAccountUsageRecord" (
                        "id" TEXT NOT NULL PRIMARY KEY,
                        "accountId" TEXT NOT NULL,
                        "providerId" TEXT NOT NULL,
                        "recordId" TEXT NOT NULL,
                        "accountSubjectId" TEXT NOT NULL,
                        "quotaScope" TEXT NOT NULL,
                        "quotaScopeIdKey" TEXT NOT NULL
                    );
                    CREATE UNIQUE INDEX "ProviderAccountUsageRecord_accountId_recordId_key"
                    ON "ProviderAccountUsageRecord"("accountId", "recordId");
                    CREATE UNIQUE INDEX "paur_identity_key"
                    ON "ProviderAccountUsageRecord"(
                        "accountId", "providerId", "accountSubjectId", "quotaScope", "quotaScopeIdKey"
                    );
                    CREATE TABLE "ConnectedServiceUsageSource" (
                        "id" TEXT NOT NULL PRIMARY KEY,
                        "accountId" TEXT NOT NULL,
                        "providerAccountUsageRecordId" TEXT NOT NULL,
                        CONSTRAINT "csus_record_fkey"
                            FOREIGN KEY ("accountId", "providerAccountUsageRecordId")
                            REFERENCES "ProviderAccountUsageRecord" ("accountId", "recordId")
                            ON DELETE CASCADE ON UPDATE CASCADE
                    );
                    CREATE INDEX "csus_record_idx"
                    ON "ConnectedServiceUsageSource"("accountId", "providerAccountUsageRecordId");
                    INSERT INTO "ProviderAccountUsageRecord" (
                        "id", "accountId", "providerId", "recordId", "accountSubjectId",
                        "quotaScope", "quotaScopeIdKey"
                    ) VALUES (
                        'usage-1', 'account-1', 'provider-1', 'record-1', 'subject-1',
                        'account', 'scope-key-1'
                    );
                    INSERT INTO "ConnectedServiceUsageSource" (
                        "id", "accountId", "providerAccountUsageRecordId"
                    ) VALUES (
                        'source-1', 'account-1', 'record-1'
                    );
                    CREATE TABLE "SessionSystemRecord" (
                        "id" TEXT NOT NULL PRIMARY KEY,
                        "accountId" TEXT NOT NULL,
                        "sessionId" TEXT NOT NULL,
                        "namespace" TEXT NOT NULL,
                        "kind" TEXT NOT NULL,
                        "localId" TEXT NOT NULL,
                        "updatedAt" DATETIME NOT NULL
                    );
                    CREATE INDEX "ssr_account_session_kind_updated_id_idx"
                    ON "SessionSystemRecord"(
                        "accountId", "sessionId", "namespace", "kind", "updatedAt" DESC, "id" DESC
                    );
                    INSERT INTO "SessionSystemRecord" (
                        "id", "accountId", "sessionId", "namespace", "kind", "localId", "updatedAt"
                    ) VALUES (
                        'system-1', 'account-1', 'session-1', 'runtime', 'status', 'local-1',
                        '2026-07-27T00:00:00.000Z'
                    );
                `);
                const insertApplied = db.prepare(`
                    INSERT INTO "_prisma_migrations" (
                        "id", "checksum", "finished_at", "migration_name", "applied_steps_count"
                    ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)
                `);
                for (const migration of predecessorMigrations) {
                    insertApplied.run(`${migration.name}-id`, migration.checksum, migration.name);
                }
            } finally {
                db.close();
            }

            await expect(
                applySqliteMigrations({ databasePath: dbPath, migrationsDir }),
            ).resolves.toEqual({ applied: [correctionMigrationName] });

            const migrated = new DatabaseSync(dbPath);
            try {
                const turnColumns = migrated
                    .prepare(`SELECT name FROM pragma_table_info('SessionTurn') ORDER BY name`)
                    .all()
                    .map((row) => String((row as { name: unknown }).name));
                expect(turnColumns).toEqual(expect.arrayContaining([
                    "agentId",
                    "agentTurnId",
                    "agentRollbackOrdinal",
                ]));
                expect(turnColumns).not.toEqual(expect.arrayContaining([
                    "provider",
                    "providerTurnId",
                    "providerRollbackOrdinal",
                ]));
                expect(
                    migrated.prepare(`
                        SELECT "agentId", "agentTurnId", "agentRollbackOrdinal"
                        FROM "SessionTurn" WHERE "id" = 'turn-1'
                    `).get(),
                ).toEqual({
                    agentId: "codex",
                    agentTurnId: "provider-turn-1",
                    agentRollbackOrdinal: 7,
                });

                const indexes = migrated
                    .prepare(`
                        SELECT name FROM sqlite_master
                        WHERE type = 'index'
                          AND name IN (
                            'SessionTurn_sessionId_provider_providerTurnId_idx',
                            'SessionTurn_sessionId_agentId_agentTurnId_idx',
                            'paur_identity_key',
                            'paur_scope_key',
                            'csus_paur_idx',
                            'csus_record_idx',
                            'ssr_account_session_kind_updated_id_idx',
                            'SessionSystemRecord_account_kind_updated_idx'
                          )
                        ORDER BY name
                    `)
                    .all()
                    .map((row) => String((row as { name: unknown }).name));
                expect(indexes).toEqual([
                    "SessionSystemRecord_account_kind_updated_idx",
                    "SessionTurn_sessionId_agentId_agentTurnId_idx",
                    "csus_record_idx",
                    "paur_scope_key",
                ]);
                expect(
                    migrated.prepare(`
                        SELECT "id", "providerId", "recordId"
                        FROM "ProviderAccountUsageRecord" WHERE "id" = 'usage-1'
                    `).get(),
                ).toEqual({
                    id: "usage-1",
                    providerId: "provider-1",
                    recordId: "record-1",
                });
                expect(
                    migrated.prepare(`
                        SELECT "id", "providerAccountUsageRecordId"
                        FROM "ConnectedServiceUsageSource" WHERE "id" = 'source-1'
                    `).get(),
                ).toEqual({
                    id: "source-1",
                    providerAccountUsageRecordId: "record-1",
                });
                expect(
                    migrated.prepare(`
                        SELECT "id", "namespace", "kind"
                        FROM "SessionSystemRecord" WHERE "id" = 'system-1'
                    `).get(),
                ).toEqual({
                    id: "system-1",
                    namespace: "runtime",
                    kind: "status",
                });
                expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            } finally {
                migrated.close();
            }
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects a dirty SQLite lineage collision without partially renaming columns or recording the correction", async () => {
        const correctionMigrationName = "20260725110000_reconcile_predecessor_migration_lineage";
        const correctionSql = await readFile(
            join(
                import.meta.dirname,
                "..",
                "prisma",
                "sqlite",
                "migrations",
                correctionMigrationName,
                "migration.sql",
            ),
            "utf8",
        );
        const migrationsDir = await createMigrationDir(
            "happier-prisma-sqlite-dirty-lineage-",
            [{ name: correctionMigrationName, sql: correctionSql }],
        );
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-dirty-lineage-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                db.exec(`
                    CREATE TABLE "_prisma_migrations" (
                        "id" TEXT NOT NULL PRIMARY KEY,
                        "checksum" TEXT NOT NULL,
                        "finished_at" DATETIME,
                        "migration_name" TEXT NOT NULL,
                        "logs" TEXT,
                        "rolled_back_at" DATETIME,
                        "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
                    );
                    INSERT INTO "_prisma_migrations" (
                        "id", "checksum", "finished_at", "migration_name", "applied_steps_count"
                    ) VALUES
                        (
                            'turn-id',
                            '0527a67d34b182b04439cb9000108d4a0275dd54769d2cb66924533753dca1ea',
                            CURRENT_TIMESTAMP,
                            '20260517190000_add_session_turns',
                            1
                        ),
                        (
                            'usage-id',
                            'a7677b52c4e91a9018dd4b77435f8fa2dd09b68e074d67f3bd60cf041c4ab4d5',
                            CURRENT_TIMESTAMP,
                            '20260630162000_add_provider_account_usage_records',
                            1
                        );
                    CREATE TABLE "SessionTurn" (
                        "id" TEXT NOT NULL PRIMARY KEY,
                        "sessionId" TEXT NOT NULL,
                        "provider" TEXT,
                        "providerTurnId" TEXT,
                        "providerRollbackOrdinal" INTEGER
                    );
                    INSERT INTO "SessionTurn" (
                        "id", "sessionId", "provider", "providerTurnId", "providerRollbackOrdinal"
                    ) VALUES (
                        'turn-1', 'session-1', 'codex', 'provider-turn-1', 7
                    );
                    CREATE INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"
                    ON "SessionTurn"("sessionId", "provider", "providerTurnId");
                    CREATE INDEX "SessionTurn_sessionId_agentId_agentTurnId_idx"
                    ON "SessionTurn"("sessionId", "id");
                `);
            } finally {
                db.close();
            }

            await expect(
                applySqliteMigrations({ databasePath: dbPath, migrationsDir }),
            ).rejects.toThrow(/already exists/i);

            const rejected = new DatabaseSync(dbPath);
            try {
                const turnColumns = rejected
                    .prepare(`SELECT name FROM pragma_table_info('SessionTurn') ORDER BY name`)
                    .all()
                    .map((row) => String((row as { name: unknown }).name));
                expect(turnColumns).toEqual(expect.arrayContaining([
                    "provider",
                    "providerTurnId",
                    "providerRollbackOrdinal",
                ]));
                expect(turnColumns).not.toEqual(expect.arrayContaining([
                    "agentId",
                    "agentTurnId",
                    "agentRollbackOrdinal",
                ]));
                expect(
                    rejected.prepare(`
                        SELECT "provider", "providerTurnId", "providerRollbackOrdinal"
                        FROM "SessionTurn" WHERE "id" = 'turn-1'
                    `).get(),
                ).toEqual({
                    provider: "codex",
                    providerTurnId: "provider-turn-1",
                    providerRollbackOrdinal: 7,
                });
                expect(
                    rejected.prepare(`
                        SELECT name FROM sqlite_master
                        WHERE type = 'index'
                          AND name IN (
                            'SessionTurn_sessionId_provider_providerTurnId_idx',
                            'SessionTurn_sessionId_agentId_agentTurnId_idx'
                          )
                        ORDER BY name
                    `).all(),
                ).toEqual([
                    { name: "SessionTurn_sessionId_agentId_agentTurnId_idx" },
                    { name: "SessionTurn_sessionId_provider_providerTurnId_idx" },
                ]);
                expect(
                    rejected.prepare(`
                        SELECT COUNT(*) AS count FROM "_prisma_migrations"
                        WHERE "migration_name" = ?
                    `).get(correctionMigrationName),
                ).toEqual({ count: 0 });
            } finally {
                rejected.close();
            }
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects migration directories that are missing migration.sql", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-missing-sql-", []);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-missing-sql-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            await mkdir(join(migrationsDir, "20260101000000_missing_sql"), { recursive: true });

            await expect(applySqliteMigrations({ databasePath: dbPath, migrationsDir })).rejects.toThrow(
                /missing migration\.sql/i,
            );
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("applies pending sqlite migrations and records them in _prisma_migrations", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-", [
            { name: "20260101000000_first", sql: 'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);' },
            { name: "20260102000000_second", sql: 'ALTER TABLE "Account" ADD COLUMN "name" TEXT;' },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            const result = await applySqliteMigrations({ databasePath: dbPath, migrationsDir });
            expect(result.applied).toEqual(["20260101000000_first", "20260102000000_second"]);

            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                const applied = db
                    .prepare('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name')
                    .all() as Array<{ migration_name: string }>;
                expect(applied.map((row) => row.migration_name)).toEqual(result.applied);
                const rows = db.prepare('PRAGMA table_info("Account")').all() as Array<{ name: string }>;
                expect(rows.map((row) => row.name)).toContain("name");
            } finally {
                db.close();
            }
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("applies the requested busy timeout before SQLite migration statements", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-timeout-", [
            {
                name: "20260101000000_timeout_probe",
                sql: "CREATE TABLE BusyTimeoutProbe AS SELECT timeout FROM pragma_busy_timeout;",
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-timeout-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            await applySqliteMigrations({
                databasePath: dbPath,
                migrationsDir,
                busyTimeoutMs: 12_000,
            });

            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                expect(db.prepare("SELECT timeout FROM BusyTimeoutProbe").get()).toEqual({
                    timeout: 12_000,
                });
            } finally {
                db.close();
            }
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects sqlite migrations when an applied checksum drifts from the migration file", async () => {
        const migrations = [
            { name: "20260101000000_first", sql: 'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);' },
        ] as const;
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-drift-", migrations);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-drift-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            await applySqliteMigrations({ databasePath: dbPath, migrationsDir });
            await writeFile(
                join(migrationsDir, migrations[0].name, "migration.sql"),
                'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "name" TEXT);',
                "utf8",
            );

            await expect(applySqliteMigrations({ databasePath: dbPath, migrationsDir })).rejects.toThrow(
                /checksum mismatch/i,
            );
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects renamed sqlite migrations when duplicate DDL cannot prove the existing schema shape", async () => {
        const migrationName = "20260101123000_add_pending_delivery_state";
        const olderMigrationName = "20260101180000_add_pending_delivery_state";
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-renamed-", [
            {
                name: migrationName,
                sql: [
                    'ALTER TABLE "SessionPendingMessage" ADD COLUMN "deliveryState" TEXT;',
                    'ALTER TABLE "SessionPendingMessage" ADD COLUMN "deliveryBlockedReason" TEXT;',
                    'CREATE INDEX "SessionPendingMessage_sid_status_dstate_position_idx"',
                    'ON "SessionPendingMessage"("sessionId", "status", "deliveryState", "position");',
                ].join("\n"),
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-renamed-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                db.exec(
                    [
                        'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);',
                        'CREATE TABLE "SessionPendingMessage" (',
                        '  "id" TEXT PRIMARY KEY,',
                        '  "sessionId" TEXT NOT NULL,',
                        '  "status" TEXT NOT NULL,',
                        '  "position" INTEGER NOT NULL,',
                        '  "deliveryState" TEXT,',
                        '  "deliveryBlockedReason" TEXT',
                        ');',
                        'CREATE INDEX "SessionPendingMessage_sid_status_dstate_position_idx"',
                        'ON "SessionPendingMessage"("sessionId", "status", "deliveryState", "position");',
                        "CREATE TABLE _prisma_migrations (",
                        "  id TEXT PRIMARY KEY,",
                        "  checksum TEXT NOT NULL,",
                        "  finished_at DATETIME,",
                        "  migration_name TEXT NOT NULL,",
                        "  logs TEXT,",
                        "  rolled_back_at DATETIME,",
                        "  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,",
                        "  applied_steps_count INTEGER NOT NULL DEFAULT 0",
                        ");",
                        "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)",
                        `VALUES ('older-migration-id', 'older-checksum', CURRENT_TIMESTAMP, '${olderMigrationName}', 1);`,
                    ].join("\n"),
                );
            } finally {
                db.close();
            }

            await expect(applySqliteMigrations({ databasePath: dbPath, migrationsDir })).rejects.toThrow(
                /cannot be marked applied safely/i,
            );

            const checkDb = new DatabaseSync(dbPath);
            try {
                const applied = checkDb
                    .prepare("SELECT migration_name FROM _prisma_migrations")
                    .all() as Array<{ migration_name: string }>;
                expect(applied.map((row) => row.migration_name)).toEqual([olderMigrationName]);
            } finally {
                checkDb.close();
            }
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects unsafe sqlite legacy migration backfills when later statements are still unapplied", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-legacy-", [
            {
                name: "20260101000000_first",
                sql: [
                    'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);',
                    'CREATE TABLE "Widget" ("id" TEXT PRIMARY KEY);',
                ].join("\n"),
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-legacy-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);');
            } finally {
                db.close();
            }

            await expect(applySqliteMigrations({ databasePath: dbPath, migrationsDir })).rejects.toThrow(
                /cannot be marked applied safely/i,
            );
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects sqlite legacy migration backfills when an existing table has the wrong shape", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-legacy-shape-", [
            {
                name: "20260101000000_first",
                sql: 'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "requiredValue" TEXT NOT NULL);',
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-legacy-shape-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "requiredValue" TEXT);');
            } finally {
                db.close();
            }

            await expect(applySqliteMigrations({ databasePath: dbPath, migrationsDir })).rejects.toThrow(
                /cannot be marked applied safely/i,
            );
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("records sqlite legacy migrations when only transaction wrappers and idempotent cleanup statements remain", async () => {
        const migrationName = "20260101000000_first";
        const migrationsDir = await createMigrationDir("happier-prisma-sqlite-legacy-safe-", [
            {
                name: migrationName,
                sql: [
                    "BEGIN;",
                    'DROP INDEX IF EXISTS "Account_old_idx";',
                    "COMMIT;",
                ].join("\n"),
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-sqlite-legacy-safe-db-"));
        const dbPath = join(dataDir, "test.sqlite");

        try {
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(dbPath);
            try {
                db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);');
            } finally {
                db.close();
            }

            const result = await applySqliteMigrations({ databasePath: dbPath, migrationsDir });
            expect(result.applied).toEqual([migrationName]);

            const checkDb = new DatabaseSync(dbPath);
            try {
                const applied = checkDb
                    .prepare('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name')
                    .all() as Array<{ migration_name: string }>;
                expect(applied.map((row) => row.migration_name)).toEqual([migrationName]);
            } finally {
                checkDb.close();
            }
        } finally {
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});

describe("applyPostgresMigrations", () => {
    it("applies pending postgres migrations to a pglite database and records them", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-postgres-", [
            { name: "20260101000000_first", sql: 'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);' },
            { name: "20260102000000_second", sql: 'ALTER TABLE "Account" ADD COLUMN "name" TEXT;' },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-pglite-"));
        const db = new PGlite(dataDir);

        try {
            await db.waitReady;
            const result = await applyPostgresMigrations({ db, migrationsDir });
            expect(result.applied).toEqual(["20260101000000_first", "20260102000000_second"]);

            const applied = await db.query('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
            expect(applied.rows.map((row) => String((row as { migration_name: string }).migration_name))).toEqual(result.applied);
            const columns = await db.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'Account'
                ORDER BY column_name
            `);
            expect(columns.rows.map((row) => String((row as { column_name: string }).column_name))).toContain("name");
        } finally {
            await db.close();
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects postgres migrations when an applied checksum drifts from the migration file", async () => {
        const migrations = [
            { name: "20260101000000_first", sql: 'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);' },
        ] as const;
        const migrationsDir = await createMigrationDir("happier-prisma-postgres-drift-", migrations);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-pglite-drift-"));
        const db = new PGlite(dataDir);

        try {
            await db.waitReady;
            await applyPostgresMigrations({ db, migrationsDir });
            await writeFile(
                join(migrationsDir, migrations[0].name, "migration.sql"),
                'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "name" TEXT);',
                "utf8",
            );

            await expect(applyPostgresMigrations({ db, migrationsDir })).rejects.toThrow(/checksum mismatch/i);
        } finally {
            await db.close();
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects unsafe postgres legacy migration backfills when later statements are still unapplied", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-postgres-legacy-", [
            {
                name: "20260101000000_first",
                sql: [
                    'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);',
                    'CREATE TABLE "Widget" ("id" TEXT PRIMARY KEY);',
                ].join("\n"),
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-pglite-legacy-"));
        const db = new PGlite(dataDir);

        try {
            await db.waitReady;
            await db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);');

            await expect(applyPostgresMigrations({ db, migrationsDir })).rejects.toThrow(/cannot be marked applied safely/i);
        } finally {
            await db.close();
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("rejects postgres legacy migration backfills when an existing table has the wrong shape", async () => {
        const migrationsDir = await createMigrationDir("happier-prisma-postgres-legacy-shape-", [
            {
                name: "20260101000000_first",
                sql: 'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "requiredValue" TEXT NOT NULL);',
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-pglite-legacy-shape-"));
        const db = new PGlite(dataDir);

        try {
            await db.waitReady;
            await db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "requiredValue" TEXT);');

            await expect(applyPostgresMigrations({ db, migrationsDir })).rejects.toThrow(
                /cannot be marked applied safely/i,
            );
        } finally {
            await db.close();
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it("records postgres legacy migrations when only transaction wrappers and idempotent cleanup statements remain", async () => {
        const migrationName = "20260101000000_first";
        const migrationsDir = await createMigrationDir("happier-prisma-postgres-legacy-safe-", [
            {
                name: migrationName,
                sql: [
                    "BEGIN;",
                    'DROP INDEX IF EXISTS "Account_old_idx";',
                    "COMMIT;",
                ].join("\n"),
            },
        ]);
        const dataDir = await mkdtemp(join(tmpdir(), "happier-prisma-pglite-legacy-safe-"));
        const db = new PGlite(dataDir);

        try {
            await db.waitReady;
            await db.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);');

            const result = await applyPostgresMigrations({ db, migrationsDir });
            expect(result.applied).toEqual([migrationName]);

            const applied = await db.query('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
            expect(applied.rows.map((row) => String((row as { migration_name: string }).migration_name))).toEqual([migrationName]);
        } finally {
            await db.close();
            await rm(migrationsDir, { recursive: true, force: true });
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});
