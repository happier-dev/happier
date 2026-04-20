import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

function createUnsafeLegacyMigrationError(migration: PrismaMigration, originalError: unknown): Error {
    const details = String((originalError as { message?: string })?.message ?? originalError ?? "").trim();
    return new Error(
        details
            ? `[prisma-migrations] legacy migration ${migration.name} cannot be marked applied safely: ${details}`
            : `[prisma-migrations] legacy migration ${migration.name} cannot be marked applied safely`,
    );
}

function splitMigrationStatements(sql: string): string[] {
    return String(sql ?? "")
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => `${statement};`);
}

function normalizeSqlStatement(statement: string): string {
    return String(statement ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/;$/, "")
        .toLowerCase();
}

function isLegacyTransactionWrapperStatement(statement: string): boolean {
    const normalized = normalizeSqlStatement(statement);
    return (
        normalized === "begin" ||
        normalized === "begin transaction" ||
        normalized === "start transaction" ||
        normalized === "commit" ||
        normalized === "commit transaction" ||
        normalized === "end" ||
        normalized === "rollback" ||
        normalized === "rollback transaction" ||
        normalized.startsWith("savepoint ") ||
        normalized.startsWith("release savepoint ") ||
        normalized.startsWith("rollback to savepoint ")
    );
}

function isIdempotentLegacyCleanupStatement(statement: string): boolean {
    const normalized = normalizeSqlStatement(statement);
    return (
        /^drop\s+(index|table|view|sequence|trigger)\s+if\s+exists\b/.test(normalized) ||
        /^create\s+(unique\s+)?(index|table|view)\s+if\s+not\s+exists\b/.test(normalized) ||
        /^alter\s+table\b.+\bdrop\s+(column|constraint)\s+if\s+exists\b/.test(normalized) ||
        /^alter\s+table\b.+\badd\s+column\s+if\s+not\s+exists\b/.test(normalized)
    );
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

async function canSafelyRecordLegacyMigration(params: Readonly<{
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
                if (!isIdempotentLegacyCleanupStatement(statement)) {
                    return false;
                }
            } catch (error) {
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
                if (!isLikelyAlreadyAppliedError(error)) {
                    return false;
                }
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
        const sql = await readFile(sqlPath, "utf8").catch(() => "");
        if (!sql.trim()) {
            continue;
        }
        migrations.push(Object.freeze({ name, sql, checksum: sha256Hex(sql) }));
    }
    return migrations;
}

async function ensureSqliteModule(): Promise<SqliteDatabaseModule> {
    return await import("node:sqlite");
}

export async function applySqliteMigrations(params: Readonly<{ databasePath: string; migrationsDir: string }>): Promise<{ applied: string[] }> {
    const { DatabaseSync } = await ensureSqliteModule();
    await mkdir(dirname(params.databasePath), { recursive: true }).catch(() => {});
    const db = new DatabaseSync(params.databasePath);
    try {
        db.exec(
            [
                "CREATE TABLE IF NOT EXISTS _prisma_migrations (",
                "  id TEXT PRIMARY KEY,",
                "  checksum TEXT NOT NULL,",
                "  finished_at DATETIME,",
                "  migration_name TEXT NOT NULL,",
                "  logs TEXT,",
                "  rolled_back_at DATETIME,",
                "  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,",
                "  applied_steps_count INTEGER NOT NULL DEFAULT 0",
                ");",
            ].join("\n"),
        );

        const migrations = await listPrismaMigrations(params.migrationsDir);
        const appliedRows = db
            .prepare("SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL")
            .all() as Array<{ migration_name: string; checksum: string }>;
        const appliedChecksums = mapAppliedMigrations(
            appliedRows.map((row) => ({
                name: row.migration_name,
                checksum: row.checksum,
            })),
        );
        const applied = new Set(appliedChecksums.keys());
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
        const tableNames = new Set(tables.map((row) => String(row.name ?? "").trim()).filter(Boolean));
        const hasCoreTables = tableNames.has("Account") || tableNames.has("account") || tableNames.has("accounts");
        const legacyMode = applied.size === 0 && hasCoreTables;
        const insertApplied = db.prepare(
            "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)",
        );

        const appliedNow: string[] = [];
        for (const migration of migrations) {
            if (applied.has(migration.name)) {
                ensureAppliedMigrationChecksum(migration, appliedChecksums);
                continue;
            }
            db.exec("BEGIN");
            try {
                db.exec(migration.sql);
                insertApplied.run(randomUUID(), migration.checksum, migration.name);
                db.exec("COMMIT");
                appliedNow.push(migration.name);
                applied.add(migration.name);
                appliedChecksums.set(migration.name, migration.checksum);
            } catch (error) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // ignore
                }
                if (legacyMode && (isLikelyAlreadyAppliedError(error) || isLikelyNestedTransactionWrapperError(error))) {
                    const safeLegacyBackfill = await canSafelyRecordLegacyMigration({
                        migration,
                        exec: (sql) => db.exec(sql),
                    });
                    if (!safeLegacyBackfill) {
                        throw createUnsafeLegacyMigrationError(migration, error);
                    }
                    insertApplied.run(randomUUID(), migration.checksum, migration.name);
                    appliedNow.push(migration.name);
                    applied.add(migration.name);
                    appliedChecksums.set(migration.name, migration.checksum);
                    continue;
                }
                throw error;
            }
        }

        return { applied: appliedNow };
    } finally {
        db.close();
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
                const safeLegacyBackfill = await canSafelyRecordLegacyMigration({
                    migration,
                    exec: (sql) => params.db.exec(sql),
                });
                if (!safeLegacyBackfill) {
                    throw createUnsafeLegacyMigrationError(migration, error);
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
