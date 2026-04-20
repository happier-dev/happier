import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import { applyPostgresMigrations, applySqliteMigrations } from "./prismaMigrations";

async function createMigrationDir(prefix: string, migrations: ReadonlyArray<Readonly<{ name: string; sql: string }>>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    for (const migration of migrations) {
        const migrationDir = join(dir, migration.name);
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, "migration.sql"), migration.sql, "utf8");
    }
    return dir;
}

describe("applySqliteMigrations", () => {
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
                /legacy migration/i,
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
                    'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);',
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

            await expect(applyPostgresMigrations({ db, migrationsDir })).rejects.toThrow(/legacy migration/i);
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
                    'CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);',
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
