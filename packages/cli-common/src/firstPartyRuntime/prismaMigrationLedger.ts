import { openPersonalHomeSqliteDatabase } from './personalHome/sqlite.js';

export type PrismaMigrationLedgerRow = Readonly<{
    migration_name: unknown;
    checksum: unknown;
    finished_at: unknown;
    rolled_back_at: unknown;
}>;

/** Shared ledger access; callers retain their domain's frontier/admission policy. */
export async function readPrismaMigrationLedger(
    query: (sql: string) => readonly PrismaMigrationLedgerRow[] | Promise<readonly PrismaMigrationLedgerRow[]>,
): Promise<readonly PrismaMigrationLedgerRow[]> {
    return await query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations');
}

export async function readSqlitePrismaMigrationLedger(databasePath: string): Promise<readonly PrismaMigrationLedgerRow[]> {
    const database = openPersonalHomeSqliteDatabase(databasePath, { readOnly: true });
    try {
        // SQLite driver rows are untyped; every selected value remains unknown at this boundary.
        return await readPrismaMigrationLedger(sql => database.prepare(sql).all() as PrismaMigrationLedgerRow[]);
    } finally {
        database.close();
    }
}
