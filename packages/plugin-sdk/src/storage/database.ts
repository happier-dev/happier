/** @moduleRealm daemon */
import type { StorageScopeService } from '../storage.js';

/** The closed scalar set admitted by the host-owned SQLite boundary. */
export type DaemonDatabaseValue = null | string | number | bigint | Uint8Array;

/**
 * Query rows are host-created null-prototype records. The public type keeps
 * their values in the SQLite scalar set and does not expose a driver object.
 */
export type DaemonDatabaseRow = Readonly<Record<string, DaemonDatabaseValue>>;

export type DaemonDatabaseOperationOptions = Readonly<{
    signal?: AbortSignal;
}>;

export type DaemonDatabaseExecutionResult = Readonly<{
    changes: number;
    lastInsertRowId?: number | bigint;
}>;

export interface DaemonDatabaseReadTransaction {
    query<T extends DaemonDatabaseRow = DaemonDatabaseRow>(
        sql: string,
        params?: readonly DaemonDatabaseValue[],
        options?: DaemonDatabaseOperationOptions,
    ): Promise<readonly T[]>;
}

/** An ordinary database transaction deliberately has no nested transaction API. */
export interface DaemonDatabaseTransaction extends DaemonDatabaseReadTransaction {
    execute(
        sql: string,
        params?: readonly DaemonDatabaseValue[],
        options?: DaemonDatabaseOperationOptions,
    ): Promise<DaemonDatabaseExecutionResult>;
}

/** Read-only handle used solely for the retained incumbent query fixture. */
export interface DaemonDatabaseMigrationReadTransaction extends DaemonDatabaseReadTransaction {}

/**
 * Migration callbacks receive a bounded statement handle, never a driver,
 * connection, path, or transaction-control escape hatch.
 */
export interface DaemonDatabaseMigrationTransaction extends DaemonDatabaseReadTransaction {
    execute(
        sql: string,
        params?: readonly DaemonDatabaseValue[],
        options?: DaemonDatabaseOperationOptions,
    ): Promise<DaemonDatabaseExecutionResult>;
}

/** Descriptor identity is static; only its matching callback is executable. */
export type DaemonDatabaseMigrationDeclaration = Readonly<{
    version: number;
    id: string;
}>;

export type DaemonDatabaseMigration = DaemonDatabaseMigrationDeclaration & Readonly<{
    up: (transaction: DaemonDatabaseMigrationTransaction) => Promise<void>;
}>;

/**
 * The host retains this exact predecessor callback with the adopted
 * generation and runs it before a candidate migration can commit.
 */
export type DaemonDatabaseIncumbentQueryFixture = Readonly<{
    id: string;
    run: (transaction: DaemonDatabaseMigrationReadTransaction) => Promise<void>;
}>;

export interface DaemonDatabase extends DaemonDatabaseTransaction {
    transaction<T>(
        operation: (transaction: DaemonDatabaseTransaction) => Promise<T>,
        options?: DaemonDatabaseOperationOptions,
    ): Promise<T>;
}

/**
 * Async daemon-local database entry point. The host validates static
 * declaration/callback correspondence and currentness before admitting work.
 */
export interface DaemonDatabaseService {
    database(
        name: string,
        options: Readonly<{
            migrations?: readonly DaemonDatabaseMigration[];
            incumbentQueryFixture: DaemonDatabaseIncumbentQueryFixture;
            signal?: AbortSignal;
        }>,
    ): Promise<DaemonDatabase>;
}

/** The daemon KV scope extended by its one host-owned database owner. */
export interface DaemonDatabaseStorageScope extends StorageScopeService, DaemonDatabaseService {}
