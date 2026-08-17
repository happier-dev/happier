import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runSqliteMigrationDeploy } from "./migrate.sqlite.deploy";
import { applySqliteMigrations } from "./prismaMigrations";

type NodeSqliteDatabase = Readonly<{
    exec: (sql: string) => void;
    prepare: (sql: string) => Readonly<{
        get: (...params: unknown[]) => unknown;
        all: (...params: unknown[]) => unknown[];
        run: (...params: unknown[]) => unknown;
    }>;
    close: () => void;
}>;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => NodeSqliteDatabase;
};

const SESSION_SYSTEM_RECORD_EXPAND_MIGRATION =
    "20260731170000_expand_session_system_record_addresses";
const SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION =
    "20260810120000_contract_session_system_record_addresses";

async function copyRealSqliteMigrationsThrough(params: Readonly<{
    sourceDir: string;
    destinationDir: string;
    throughMigration: string;
}>): Promise<void> {
    const migrationNames = (await readdir(params.sourceDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    const endIndex = migrationNames.indexOf(params.throughMigration);
    if (endIndex < 0) {
        throw new Error(`Missing fixture migration: ${params.throughMigration}`);
    }
    await mkdir(params.destinationDir, { recursive: true });
    await copyFile(
        join(params.sourceDir, "migration_lock.toml"),
        join(params.destinationDir, "migration_lock.toml"),
    );
    for (const migrationName of migrationNames.slice(0, endIndex + 1)) {
        await cp(
            join(params.sourceDir, migrationName),
            join(params.destinationDir, migrationName),
            { recursive: true, force: false },
        );
    }
}

describe("migrate.sqlite.deploy.ts", () => {
    let tmpDir = "";
    let lightDataDir = "";
    let serverRoot = "";
    let migrationsDir = "";

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "happier-server-light-deploy-"));
        lightDataDir = join(tmpDir, "happy server #light");
        serverRoot = join(tmpDir, "server");
        migrationsDir = join(serverRoot, "prisma", "sqlite", "migrations");
        await mkdir(lightDataDir, { recursive: true });
        await mkdir(migrationsDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it("applies through the real Node adapter with the URL busy timeout", async () => {
        const migrationName = "20260101000000_first";
        const migrationDir = join(migrationsDir, migrationName);
        await mkdir(migrationDir, { recursive: true });
        await writeFile(
            join(migrationDir, "migration.sql"),
            [
                "CREATE TABLE Account(id INTEGER);",
                "CREATE TABLE BusyTimeoutProbe AS SELECT timeout FROM pragma_busy_timeout;",
                "",
            ].join("\n"),
            "utf8",
        );

        const env: NodeJS.ProcessEnv = {
            HAPPY_SERVER_LIGHT_DATA_DIR: lightDataDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: lightDataDir,
        };

        await expect(
            runSqliteMigrationDeploy({
                env,
                serverRoot,
                runSchemaSync: async () => {},
            }),
        ).resolves.toEqual({ applied: [migrationName] });

        const databasePath = join(lightDataDir, "happier-server-light.sqlite");
        expect(env.DATABASE_URL).toBe(
            `${pathToFileURL(databasePath).href}?socket_timeout=30&connection_limit=1`,
        );
        const db = new DatabaseSync(databasePath);
        try {
            expect(db.prepare("SELECT timeout FROM BusyTimeoutProbe").get()).toEqual({
                timeout: 30_000,
            });
        } finally {
            db.close();
        }
    });

    it("fails closed when an explicit DATABASE_URL is not a SQLite file URL", async () => {
        const migrationDir = join(migrationsDir, "20260101000000_first");
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, "migration.sql"), "CREATE TABLE Account(id INTEGER);\n", "utf8");

        await expect(
            runSqliteMigrationDeploy({
                env: {
                    HAPPY_SERVER_LIGHT_DATA_DIR: lightDataDir,
                    HAPPIER_SERVER_LIGHT_DATA_DIR: lightDataDir,
                    DATABASE_URL: "postgresql://db.example.invalid/happier",
                },
                serverRoot,
                runSchemaSync: async () => {},
            }),
        ).rejects.toThrow(/requires DATABASE_URL=file:/i);
    });

    it("upgrades a real pre-EXPAND legacy record through backfill before CONTRACT", async () => {
        const sourceMigrationsDir = resolve(
            fileURLToPath(new URL("../prisma/sqlite/migrations/", import.meta.url)),
        );
        const preExpandMigrationsDir = join(tmpDir, "pre-expand-migrations");
        const throughContractMigrationsDir = join(tmpDir, "through-contract-migrations");
        await copyRealSqliteMigrationsThrough({
            sourceDir: sourceMigrationsDir,
            destinationDir: preExpandMigrationsDir,
            throughMigration: "20260729102000_add_voice_conversation_grant_provenance",
        });
        await copyRealSqliteMigrationsThrough({
            sourceDir: sourceMigrationsDir,
            destinationDir: throughContractMigrationsDir,
            throughMigration: SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION,
        });

        // This lifecycle test opens the same database through both the Node
        // migration executor and Prisma's generated SQLite client. Keep this
        // fixture path URI-unambiguous; the URL escaping contract is covered
        // by the adapter test above.
        const databasePath = join(tmpDir, "session-system-record-upgrade.sqlite");
        await applySqliteMigrations({
            databasePath,
            migrationsDir: preExpandMigrationsDir,
        });
        const legacyDb = new DatabaseSync(databasePath);
        try {
            legacyDb.prepare(
                'INSERT INTO "Account" ("id", "updatedAt") VALUES (?, CURRENT_TIMESTAMP)',
            ).run("legacy-account");
            legacyDb.prepare(
                'INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt") '
                + "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
            ).run("legacy-session", "legacy", "legacy-account", "{}");
            legacyDb.prepare(
                'INSERT INTO "SessionSystemRecord" '
                + '("id", "accountId", "sessionId", "namespace", "kind", "localId", "content", "updatedAt") '
                + "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
            ).run(
                "legacy-record",
                "legacy-account",
                "legacy-session",
                "memory",
                "synopsis.v1",
                "legacy-local-id",
                "{}",
            );
        } finally {
            legacyDb.close();
        }

        const originalEnvironment = {
            DATABASE_URL: process.env.DATABASE_URL,
            HAPPY_SERVER_LIGHT_DATA_DIR: process.env.HAPPY_SERVER_LIGHT_DATA_DIR,
            HAPPIER_SERVER_LIGHT_DATA_DIR: process.env.HAPPIER_SERVER_LIGHT_DATA_DIR,
            HAPPY_DB_PROVIDER: process.env.HAPPY_DB_PROVIDER,
            HAPPIER_DB_PROVIDER: process.env.HAPPIER_DB_PROVIDER,
            HAPPIER_SQLITE_MIGRATIONS_DIR: process.env.HAPPIER_SQLITE_MIGRATIONS_DIR,
        };
        Object.assign(process.env, {
            DATABASE_URL: `file:${databasePath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: lightDataDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: lightDataDir,
            HAPPY_DB_PROVIDER: "sqlite",
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPIER_SQLITE_MIGRATIONS_DIR: throughContractMigrationsDir,
        });
        try {
            await expect(
                runSqliteMigrationDeploy({
                    env: process.env,
                    serverRoot,
                    runSchemaSync: async () => {},
                }),
            ).resolves.toEqual(expect.objectContaining({
                applied: expect.arrayContaining([
                    SESSION_SYSTEM_RECORD_EXPAND_MIGRATION,
                    SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION,
                ]),
            }));
            await expect(
                runSqliteMigrationDeploy({
                    env: process.env,
                    serverRoot,
                    runSchemaSync: async () => {},
                }),
            ).resolves.toEqual({ applied: [] });
        } finally {
            for (const [key, value] of Object.entries(originalEnvironment)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }

        const upgradedDb = new DatabaseSync(databasePath);
        try {
            expect(upgradedDb.prepare(
                'SELECT "ownerKind", "pluginId", length("namespaceAddressKey") AS namespaceKeyLength, '
                + 'length("recordAddressKey") AS recordKeyLength, "version" '
                + 'FROM "SessionSystemRecord" WHERE "id" = ?',
            ).get("legacy-record")).toEqual({
                ownerKind: "host",
                pluginId: null,
                namespaceKeyLength: 32,
                recordKeyLength: 32,
                version: 1,
            });
            const systemRecordLedger = upgradedDb.prepare(
                'SELECT migration_name, checksum FROM _prisma_migrations '
                + 'WHERE migration_name IN (?, ?) '
                + 'AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
            ).all(
                SESSION_SYSTEM_RECORD_EXPAND_MIGRATION,
                SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION,
            ) as Array<{ migration_name: string; checksum: string }>;
            await expect(Promise.all([
                SESSION_SYSTEM_RECORD_EXPAND_MIGRATION,
                SESSION_SYSTEM_RECORD_CONTRACT_MIGRATION,
            ].map(async (migration_name) => ({
                migration_name,
                checksum: createHash("sha256").update(await readFile(
                    join(sourceMigrationsDir, migration_name, "migration.sql"),
                    "utf8",
                )).digest("hex"),
            })))).resolves.toEqual(systemRecordLedger);
        } finally {
            upgradedDb.close();
        }
    }, 120_000);
});
