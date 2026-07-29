import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
    applySqliteMigrations as applySqliteMigrationsWithExecutor,
    type SqliteMigrationBindValue,
    type SqliteMigrationExecutor,
} from "../sources/flavors/light/sqliteMigrations";
import {
    isLegacyTransactionWrapperStatement,
    isSafeMissingMigrationReconciliationStatement,
    splitMigrationStatements,
} from "../sources/migrations/missingMigrationReconciliation";

type PrismaMigration = Readonly<{
    name: string;
    sql: string;
    checksum: string;
}>;

type AppliedMigrationRecord = Readonly<{
    name: string;
    checksum: string;
}>;

type SqliteDatabaseModule = typeof import("node:sqlite");
type CloseableSqliteMigrationExecutor = SqliteMigrationExecutor & Readonly<{
    close: () => void;
}>;
type PostgresLikeDatabase = Readonly<{
    exec: (sql: string) => Promise<unknown> | unknown;
    query: (sql: string) => Promise<Readonly<{ rows: unknown[] }>>;
}>;

function sha256Hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

function normalizeSqlError(error: unknown): string {
    return String((error as { message?: string })?.message ?? error ?? "").toLowerCase();
}

function isLikelyAlreadyAppliedError(error: unknown): boolean {
    const message = normalizeSqlError(error);
    return message.includes("already exists") || message.includes("duplicate column") || message.includes("duplicate");
}

function isLikelyNestedTransactionWrapperError(error: unknown): boolean {
    const message = normalizeSqlError(error);
    return (
        message.includes("cannot start a transaction within a transaction") ||
        message.includes("already a transaction") ||
        message.includes("transaction is active")
    );
}

function escapeSqlString(value: string): string {
    return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function normalizeChecksum(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function createChecksumMismatchError(migration: PrismaMigration, appliedChecksum: string): Error {
    return new Error(
        `[prisma-migrations] checksum mismatch for applied migration ${migration.name}: recorded=${normalizeChecksum(appliedChecksum) || "<empty>"} current=${migration.checksum}`,
    );
}

function createUnsafeAlreadyAppliedMigrationError(migration: PrismaMigration, originalError: unknown): Error {
    const details = String((originalError as { message?: string })?.message ?? originalError ?? "").trim();
    return new Error(
        details
            ? `[prisma-migrations] migration ${migration.name} cannot be marked applied safely: ${details}`
            : `[prisma-migrations] migration ${migration.name} cannot be marked applied safely`,
    );
}

function createInvalidMigrationSqlError(migrationName: string, reason: string): Error {
    return new Error(`[prisma-migrations] ${reason} for migration ${migrationName}`);
}

function mapAppliedMigrations(rows: ReadonlyArray<AppliedMigrationRecord>): Map<string, string> {
    const applied = new Map<string, string>();
    for (const row of rows) {
        const name = String(row.name ?? "").trim();
        if (!name) {
            continue;
        }
        applied.set(name, normalizeChecksum(row.checksum));
    }
    return applied;
}

function ensureAppliedMigrationChecksum(migration: PrismaMigration, appliedChecksums: ReadonlyMap<string, string>): void {
    const appliedChecksum = appliedChecksums.get(migration.name);
    if (appliedChecksum == null) {
        return;
    }
    if (appliedChecksum !== migration.checksum) {
        throw createChecksumMismatchError(migration, appliedChecksum);
    }
}

async function canSafelyRecordAlreadyAppliedMigration(params: Readonly<{
    migration: PrismaMigration;
    exec: (sql: string) => Promise<unknown> | unknown;
}>): Promise<boolean> {
    const statements = splitMigrationStatements(params.migration.sql);
    let probedStatements = 0;

    await params.exec("BEGIN");
    try {
        for (let index = 0; index < statements.length; index += 1) {
            const statement = statements[index]!;
            if (isLegacyTransactionWrapperStatement(statement)) {
                continue;
            }
            if (!isSafeMissingMigrationReconciliationStatement(statement)) {
                return false;
            }
            probedStatements += 1;
            const savepointName = `legacy_probe_${index + 1}`;
            await params.exec(`SAVEPOINT ${savepointName}`);
            try {
                await params.exec(statement);
                try {
                    await params.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
                } catch {
                    // ignore
                }
                try {
                    await params.exec(`RELEASE SAVEPOINT ${savepointName}`);
                } catch {
                    // ignore
                }
            } catch {
                try {
                    await params.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
                } catch {
                    // ignore
                }
                try {
                    await params.exec(`RELEASE SAVEPOINT ${savepointName}`);
                } catch {
                    // ignore
                }
                return false;
            }
        }
    } finally {
        try {
            await params.exec("ROLLBACK");
        } catch {
            // ignore
        }
    }

    return probedStatements > 0;
}

async function listPrismaMigrations(migrationsDir: string): Promise<PrismaMigration[]> {
    const dir = resolve(String(migrationsDir ?? "").trim());
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const names = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

    const migrations: PrismaMigration[] = [];
    for (const name of names) {
        const sqlPath = resolve(dir, name, "migration.sql");
        let sql: string;
        try {
            sql = await readFile(sqlPath, "utf8");
        } catch {
            throw createInvalidMigrationSqlError(name, "missing migration.sql");
        }
        if (!sql.trim()) {
            throw createInvalidMigrationSqlError(name, "empty migration.sql");
        }
        migrations.push(Object.freeze({ name, sql, checksum: sha256Hex(sql) }));
    }
    return migrations;
}

async function ensureSqliteModule(): Promise<SqliteDatabaseModule> {
    return await import("node:sqlite");
}

async function createNodeSqliteExecutor(params: Readonly<{
    databasePath: string;
    busyTimeoutMs: number;
}>): Promise<CloseableSqliteMigrationExecutor> {
    const { DatabaseSync } = await ensureSqliteModule();
    const db = new DatabaseSync(params.databasePath);
    db.exec(`PRAGMA busy_timeout=${params.busyTimeoutMs};`);

    return Object.freeze({
        exec: (sql: string) => {
            db.exec(sql);
        },
        queryRows: (
            sql: string,
            values: ReadonlyArray<SqliteMigrationBindValue> = [],
        ) => db.prepare(sql).all(...values) as ReadonlyArray<
            Readonly<Record<string, unknown>>
        >,
        run: (
            sql: string,
            values: ReadonlyArray<SqliteMigrationBindValue> = [],
        ) => {
            db.prepare(sql).run(...values);
        },
        queryTableNames: () => {
            const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
            return new Set(rows.map((row) => String(row.name ?? "").trim()).filter(Boolean));
        },
        queryAppliedMigrations: () => {
            const rows = db
                .prepare("SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL")
                .all() as Array<{ migration_name: string; checksum: string }>;
            return rows.map((row) => ({
                name: row.migration_name,
                checksum: row.checksum,
            }));
        },
        insertAppliedMigration: ({ name, checksum }: { name: string; checksum: string }) => {
            db.prepare(
                "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)",
            ).run(randomUUID(), checksum, name);
        },
        close: () => {
            db.close();
        },
    });
}

export async function applySqliteMigrations(params: Readonly<{
    databasePath: string;
    migrationsDir: string;
    busyTimeoutMs?: number;
}>): Promise<{ applied: string[] }> {
    await mkdir(dirname(params.databasePath), { recursive: true }).catch(() => {});
    const executor = await createNodeSqliteExecutor({
        databasePath: params.databasePath,
        busyTimeoutMs: params.busyTimeoutMs ?? 0,
    });
    try {
        return await applySqliteMigrationsWithExecutor({
            executor,
            migrationsDir: params.migrationsDir,
        });
    } finally {
        executor.close();
    }
}

export async function applyPostgresMigrations(params: Readonly<{ db: PostgresLikeDatabase; migrationsDir: string }>): Promise<{ applied: string[] }> {
    await params.db.exec(
        [
            'CREATE TABLE IF NOT EXISTS "_prisma_migrations" (',
            '  "id" TEXT PRIMARY KEY,',
            '  "checksum" TEXT NOT NULL,',
            '  "finished_at" TIMESTAMP,',
            '  "migration_name" TEXT NOT NULL,',
            '  "logs" TEXT,',
            '  "rolled_back_at" TIMESTAMP,',
            '  "started_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,',
            '  "applied_steps_count" INTEGER NOT NULL DEFAULT 0',
            ");",
        ].join("\n"),
    );

    const migrations = await listPrismaMigrations(params.migrationsDir);
    const appliedRows = await params.db.query(
        'SELECT migration_name, checksum FROM "_prisma_migrations" WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL',
    );
    const appliedChecksums = mapAppliedMigrations(
        appliedRows.rows.map((row) => ({
            name: String((row as { migration_name?: string }).migration_name ?? ""),
            checksum: String((row as { checksum?: string }).checksum ?? ""),
        })),
    );
    const applied = new Set(appliedChecksums.keys());
    const tableRows = await params.db.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()");
    const tableNames = new Set(
        tableRows.rows
            .map((row) => String((row as { tablename?: string }).tablename ?? "").trim())
            .filter(Boolean),
    );
    const hasCoreTables = tableNames.has("Account") || tableNames.has("account") || tableNames.has("accounts");
    const legacyMode = applied.size === 0 && hasCoreTables;

    const appliedNow: string[] = [];
    for (const migration of migrations) {
        if (applied.has(migration.name)) {
            ensureAppliedMigrationChecksum(migration, appliedChecksums);
            continue;
        }
        await params.db.exec("BEGIN");
        try {
            await params.db.exec(migration.sql);
            await params.db.exec(
                [
                    'INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")',
                    `VALUES (${escapeSqlString(randomUUID())}, ${escapeSqlString(migration.checksum)}, CURRENT_TIMESTAMP, ${escapeSqlString(migration.name)}, 1)`,
                ].join(" "),
            );
            await params.db.exec("COMMIT");
            appliedNow.push(migration.name);
            applied.add(migration.name);
            appliedChecksums.set(migration.name, migration.checksum);
        } catch (error) {
            try {
                await params.db.exec("ROLLBACK");
            } catch {
                // ignore
            }
            if (legacyMode && (isLikelyAlreadyAppliedError(error) || isLikelyNestedTransactionWrapperError(error))) {
                const safeLegacyBackfill = await canSafelyRecordAlreadyAppliedMigration({
                    migration,
                    exec: (sql) => params.db.exec(sql),
                });
                if (!safeLegacyBackfill) {
                    throw createUnsafeAlreadyAppliedMigrationError(migration, error);
                }
                await params.db.exec(
                    [
                        'INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")',
                        `VALUES (${escapeSqlString(randomUUID())}, ${escapeSqlString(migration.checksum)}, CURRENT_TIMESTAMP, ${escapeSqlString(migration.name)}, 1)`,
                    ].join(" "),
                );
                appliedNow.push(migration.name);
                applied.add(migration.name);
                appliedChecksums.set(migration.name, migration.checksum);
                continue;
            }
            throw error;
        }
    }

    return { applied: appliedNow };
}
