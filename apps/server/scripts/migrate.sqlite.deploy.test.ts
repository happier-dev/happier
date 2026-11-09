import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

import { runSqliteMigrationDeploy } from "./migrate.sqlite.deploy";
import { applyPostgresMigrations, applySqliteMigrations } from "./prismaMigrations";
import { createDbMaintenanceClient } from '../sources/storage/db';
import { materializePluginCollectionContractsFromManifestTx } from '../sources/app/plugins/data/collections/contracts';
import { measurePluginCollectionStoredRowEncodedBytes } from '../sources/app/plugins/data/collections/storedRowUsage';
import { PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION, PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION, runPluginCollectionUsageBackfill } from './pluginCollectionUsageBackfill';
import { runCommand } from './runCommand';
import { applySqliteMigrationsIfNeeded } from '../sources/flavors/light/sqliteMigrations';

// Native boundary adapter: exercise the Bun runtime entry with a real SQLite engine under Node.
vi.mock('bun:sqlite', async () => {
    const { createRequire } = await import('node:module');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string) => NodeSqliteDatabase };
    return { Database: class extends DatabaseSync { query(sql: string) { return this.prepare(sql); } } };
});

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
const ACCOUNT_NAME_MIGRATION = "20261011120000_add_account_name";
const accountNameFixtures = [
    { id: "both", firstName: "  Ada  ", lastName: " Lovelace ", name: "Ada Lovelace" },
    { id: "first", firstName: "\tGrace\n", lastName: null, name: "Grace" },
    { id: "last", firstName: "\u00a0", lastName: "\u00a0Hopper\u00a0", name: "Hopper" },
    { id: "blank", firstName: "\t \n", lastName: "  ", name: null },
    { id: "unset", firstName: null, lastName: null, name: null },
    { id: "interior", firstName: "  Mary  Jane ", lastName: " Watson ", name: "Mary  Jane Watson" },
    { id: "long", firstName: "a".repeat(191), lastName: "b".repeat(191), name: `${"a".repeat(191)} ${"b".repeat(191)}` },
];

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
        lightDataDir = join(tmpDir, "happy server light");
        serverRoot = join(tmpDir, "server");
        migrationsDir = join(serverRoot, "prisma", "sqlite", "migrations");
        await mkdir(lightDataDir, { recursive: true });
        await mkdir(migrationsDir, { recursive: true });
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(tmpDir, { recursive: true, force: true });
    });

    it.each(['script', 'runtime'] as const)('backfills retained Collection rows through %s deployment and permits explicit repair', async entry => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'sqlite');
        const sourceMigrationsDir = fileURLToPath(new URL('../prisma/sqlite/migrations/', import.meta.url));
        const names = (await readdir(sourceMigrationsDir, { withFileTypes: true })).filter(entry => entry.isDirectory())
            .map(entry => entry.name).sort();
        const previous = names[names.indexOf(PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION) - 1]!;
        await copyRealSqliteMigrationsThrough({ sourceDir: sourceMigrationsDir, destinationDir: migrationsDir, throughMigration: previous });
        const databasePath = join(tmpDir, 'usage.sqlite');
        const databaseUrl = `file:${databasePath}?connection_limit=1`;
        const env = { HAPPY_SERVER_LIGHT_DATA_DIR: lightDataDir, HAPPIER_SERVER_LIGHT_DATA_DIR: lightDataDir, DATABASE_URL: databaseUrl };
        await runSqliteMigrationDeploy({ env, serverRoot, runSchemaSync: async () => {} });
        // The current generated client cannot select its new Account fields before EXPAND.
        const legacy = new DatabaseSync(databasePath);
        legacy.prepare('INSERT INTO "Account" ("id", "updatedAt") VALUES (?, CURRENT_TIMESTAMP)').run('retained');
        legacy.prepare('INSERT INTO "Account" ("id", "updatedAt") VALUES (?, CURRENT_TIMESTAMP)').run('empty');
        legacy.close();
        const client = await createDbMaintenanceClient('sqlite', databaseUrl);
        const contentEnvelope = { t: 'plain', v: { body: 'héllo 🌍', amount: 0.00001 } };
        const projections = [{ fieldId: 'id', typedEncodedValue: JSON.stringify('live') }];
        let contractId = '';
        try {
            const refs = await client.$transaction(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: {
                schemaVersion: 2, id: 'example.backfill', version: '1.0.0', displayName: 'Backfill',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                contributes: { accountCollections: [{ id: 'rows', schemaVersion: 1, rowIdField: 'id', serverReadable: ['id'], indexes: [],
                    schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' }, amount: { type: 'number' } }, required: ['id', 'body', 'amount'], additionalProperties: false },
                }] },
            } }));
            const contract = await client.pluginCollectionContract.findFirstOrThrow({ where: { pluginId: 'example.backfill' } });
            contractId = contract.id;
            const row = await client.pluginCollectionRow.create({ data: { accountId: 'retained', pluginId: 'example.backfill', collectionId: 'rows', rowId: 'live',
                revision: 1, schemaVersion: 1, contractId, contractDigest: refs[0]!.contractDigest, contentEnvelope } });
            await client.pluginCollectionProjection.create({ data: { ...projections[0]!, rowDbId: row.id, accountId: 'retained', pluginId: 'example.backfill', collectionId: 'rows', rowId: 'live', rowRevision: 1 } });
            await client.pluginCollectionRow.create({ data: { accountId: 'retained', pluginId: 'example.backfill', collectionId: 'rows', rowId: 'deleted',
                revision: 1, schemaVersion: 1, contractId, contractDigest: refs[0]!.contractDigest, contentEnvelope, deletedAt: new Date() } });
        } finally { await client.$disconnect(); }
        for (const name of [PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION, PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION]) {
            await cp(join(sourceMigrationsDir, name), join(migrationsDir, name), { recursive: true });
        }
        const deploy = async () => {
            if (entry === 'script') return runSqliteMigrationDeploy({ env, serverRoot, runSchemaSync: async () => {} });
            vi.stubGlobal('Bun', {});
            return applySqliteMigrationsIfNeeded({ env: { ...env, HAPPIER_SQLITE_AUTO_MIGRATE: '1', HAPPIER_SQLITE_MIGRATIONS_DIR: migrationsDir,
                HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'personal-home-update-record-v1' }, dataDir: lightDataDir });
        };
        const deployed = await deploy();
        expect(deployed.applied).toEqual([PLUGIN_COLLECTION_USAGE_EXPAND_MIGRATION, PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION]);
        const verify = await createDbMaintenanceClient('sqlite', databaseUrl);
        try {
            const bytes = BigInt(measurePluginCollectionStoredRowEncodedBytes({ rowId: 'live', contentEnvelope, projections }));
            expect(await verify.account.findUniqueOrThrow({ where: { id: 'retained' }, select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } }))
                .toEqual({ pluginCollectionRows: 1n, pluginCollectionEncodedBytes: bytes });
            expect(await verify.pluginCollectionUsage.findMany({ select: { rows: true, encodedBytes: true } })).toEqual([{ rows: 1n, encodedBytes: bytes }]);
            expect(await verify.pluginCollectionContractUsage.findMany({ select: { contractId: true, rows: true } })).toEqual([{ contractId, rows: 1n }]);
            expect(await verify.account.findUniqueOrThrow({ where: { id: 'empty' }, select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } }))
                .toEqual({ pluginCollectionRows: 0n, pluginCollectionEncodedBytes: 0n });
            await expect(deploy()).resolves.toEqual({ applied: [] });
            await verify.pluginCollectionRow.update({ where: { accountId_pluginId_collectionId_rowId: { accountId: 'retained', pluginId: 'example.backfill', collectionId: 'rows', rowId: 'live' } }, data: { contentEnvelope: { t: 'plain', v: { body: 'old writer changed this' } } } });
            // A process interrupted after EXPAND/backfill has no completion ledger row.
            await verify.$executeRawUnsafe('DELETE FROM _prisma_migrations WHERE migration_name = ?', PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION);
            await expect(deploy())
                .resolves.toEqual({ applied: [PLUGIN_COLLECTION_USAGE_BACKFILLED_MIGRATION] });
            const repaired = await verify.account.findUniqueOrThrow({ where: { id: 'retained' }, select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } });
            expect(repaired.pluginCollectionRows).toBe(1n);
            expect(repaired.pluginCollectionEncodedBytes).not.toBe(bytes);
            await runPluginCollectionUsageBackfill({ provider: 'sqlite', databaseUrl });
            expect(await verify.account.findUniqueOrThrow({ where: { id: 'retained' }, select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } })).toEqual(repaired);
            const commandEnvelope = { t: 'plain', v: { body: 'another old writer changed this before the command' } };
            await verify.pluginCollectionRow.update({ where: { accountId_pluginId_collectionId_rowId: {
                accountId: 'retained', pluginId: 'example.backfill', collectionId: 'rows', rowId: 'live',
            } }, data: { contentEnvelope: commandEnvelope } });
            await runCommand(process.execPath, ['./scripts/runTsx.mjs', '--tsconfig', './tsconfig.json', './scripts/pluginCollectionUsageBackfill.ts'],
                { ...process.env, HAPPIER_DB_PROVIDER: 'sqlite', DATABASE_URL: databaseUrl },
                { cwd: fileURLToPath(new URL('../', import.meta.url)) });
            expect(await verify.account.findUniqueOrThrow({ where: { id: 'retained' }, select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } }))
                .toEqual({ pluginCollectionRows: 1n, pluginCollectionEncodedBytes: BigInt(measurePluginCollectionStoredRowEncodedBytes({
                    rowId: 'live', contentEnvelope: commandEnvelope, projections,
                })) });
        } finally { await verify.$disconnect(); }
    }, 120_000);

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
            `file:${databasePath}?socket_timeout=30&connection_limit=1`,
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

    it("backfills Account.name from retained profile parts without changing those parts", async () => {
        const sourceMigrationsDir = fileURLToPath(new URL("../prisma/sqlite/migrations/", import.meta.url));
        await copyRealSqliteMigrationsThrough({
            sourceDir: sourceMigrationsDir,
            destinationDir: migrationsDir,
            throughMigration: "20261010100000_message_surface_reference_and_share_network",
        });
        const databasePath = join(lightDataDir, "happier-server-light.sqlite");
        await applySqliteMigrations({ databasePath, migrationsDir });
        const legacyDb = new DatabaseSync(databasePath);
        try {
            for (const fixture of accountNameFixtures) {
                legacyDb.prepare(
                    'INSERT INTO "Account" ("id", "firstName", "lastName", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                ).run(fixture.id, fixture.firstName, fixture.lastName);
            }
        } finally {
            legacyDb.close();
        }
        await applySqliteMigrations({ databasePath, migrationsDir: sourceMigrationsDir });
        await expect(applySqliteMigrations({ databasePath, migrationsDir: sourceMigrationsDir }))
            .resolves.toEqual({ applied: [] });
        const upgradedDb = new DatabaseSync(databasePath);
        try {
            for (const fixture of accountNameFixtures) {
                expect(upgradedDb.prepare(
                    'SELECT "firstName", "lastName", "name" FROM "Account" WHERE "id" = ?',
                ).get(fixture.id)).toEqual({
                    firstName: fixture.firstName,
                    lastName: fixture.lastName,
                    name: fixture.name,
                });
            }
            expect(upgradedDb.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
            expect(upgradedDb.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            upgradedDb.close();
        }
    });

    it("backfills the same retained Account profile on PostgreSQL and deploys twice", async () => {
        const sourceMigrationsDir = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
        const postgresMigrationsDir = join(tmpDir, "postgres-migrations");
        const stageMigration = async (name: string) => {
            await mkdir(join(postgresMigrationsDir, name), { recursive: true });
            await copyFile(join(sourceMigrationsDir, name, "migration.sql"), join(postgresMigrationsDir, name, "migration.sql"));
        };
        const postgres = new PGlite();
        try {
            // Real immutable migration sources establish the retained nullable profile columns.
            await stageMigration("20250713002718_initial");
            await stageMigration("20250827044624_add_user_profile_fields");
            await applyPostgresMigrations({ db: postgres, migrationsDir: postgresMigrationsDir });
            for (const fixture of accountNameFixtures) {
                await postgres.query(
                    'INSERT INTO "Account" ("id", "publicKey", "firstName", "lastName", "updatedAt") VALUES ($1, $1, $2, $3, CURRENT_TIMESTAMP)',
                    [fixture.id, fixture.firstName, fixture.lastName],
                );
            }
            await stageMigration(ACCOUNT_NAME_MIGRATION);
            await expect(applyPostgresMigrations({ db: postgres, migrationsDir: postgresMigrationsDir }))
                .resolves.toEqual({ applied: [ACCOUNT_NAME_MIGRATION] });
            await expect(applyPostgresMigrations({ db: postgres, migrationsDir: postgresMigrationsDir }))
                .resolves.toEqual({ applied: [] });
            for (const fixture of accountNameFixtures) {
                expect((await postgres.query(
                    'SELECT "firstName", "lastName", "name" FROM "Account" WHERE "id" = $1',
                    [fixture.id],
                )).rows).toEqual([{
                    firstName: fixture.firstName,
                    lastName: fixture.lastName,
                    name: fixture.name,
                }]);
            }
        } finally {
            await postgres.close();
        }
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
