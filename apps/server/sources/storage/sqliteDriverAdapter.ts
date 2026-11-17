import {
    ColumnTypeEnum,
    DriverAdapterError,
    type ArgType,
    type ColumnType,
    type IsolationLevel,
    type MappedError,
    type SqlDriverAdapter,
    type SqlDriverAdapterFactory,
    type SqlQuery,
    type SqlResultSet,
    type Transaction,
} from "@prisma/driver-adapter-utils";
import { fileURLToPath } from "node:url";

import { AsyncLock } from "@/utils/runtime/lock";

/**
 * The server's SQLite driver adapter for Prisma's query compiler, over the runtime's own
 * binding: `bun:sqlite` in the Bun-compiled server, `node:sqlite` under Node (tests, tsx).
 *
 * It keeps the storage contract the Rust query engine wrote, so 0.2-written databases read
 * and write unchanged:
 * - DateTime values are stored as INTEGER unix milliseconds, never ISO text;
 * - raw results map declared column types the way the Rust engine did (INTEGER as int,
 *   BIGINT and undeclared integers as bigint, DATETIME as Date, BOOLEAN as boolean);
 * - a pool of `connection_limit` connections (the URL parameter the Rust engine read; the
 *   server opens single-connection pools), with an interactive transaction holding its
 *   connection from BEGIN IMMEDIATE to COMMIT/ROLLBACK.
 *
 * SQLite's busy handler would block the JavaScript thread, and the lock holder may be
 * another connection of this same process waiting for that thread (an open read snapshot,
 * an open write transaction). So each connection runs with `busy_timeout=0` and this
 * adapter waits for a busy database asynchronously, on SQLite's own default back-off
 * schedule, up to the configured busy timeout; past it the statement fails with
 * SQLITE_BUSY mapped to Prisma's timeout code (P1008), as the Rust engine reported it.
 * While an autocommit statement or a `BEGIN IMMEDIATE` waits, its connection returns to the
 * pool between attempts, so reads are not queued behind a writer waiting for the lock.
 */

type SqliteBindValue = string | number | bigint | null | Uint8Array;

interface SqliteBindingStatement {
    readonly columnNames: readonly string[];
    readonly declaredTypes: readonly (string | null)[];
    values(args: readonly SqliteBindValue[]): unknown[][];
    run(args: readonly SqliteBindValue[]): Readonly<{ changes: number; lastInsertRowid: bigint | number }>;
}

interface SqliteBindingDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteBindingStatement;
    close(): void;
}

// bun:sqlite and node:sqlite are untyped/foreign external boundaries in this package's
// compilation environment; each is narrowed to the binding contract above immediately.
interface BunSqliteStatement {
    readonly columnNames: string[];
    readonly declaredTypes: (string | null)[];
    values(...args: SqliteBindValue[]): unknown[][];
    run(...args: SqliteBindValue[]): { changes: number; lastInsertRowid: bigint | number };
}
interface BunSqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): BunSqliteStatement;
    close(): void;
}
interface NodeSqliteStatement {
    columns(): Array<{ name: string; type: string | null }>;
    setReturnArrays(enabled: boolean): void;
    all(...args: SqliteBindValue[]): unknown[][];
    run(...args: SqliteBindValue[]): { changes: number | bigint; lastInsertRowid: bigint | number };
}
interface NodeSqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): NodeSqliteStatement;
    close(): void;
}

async function openSqliteBinding(path: string): Promise<SqliteBindingDatabase> {
    if (typeof process.versions.bun === "string") {
        const sqlite = await import("bun:sqlite");
        const Database = sqlite.Database as new (path: string, options: { safeIntegers: boolean }) => BunSqliteDatabase;
        const db = new Database(path, { safeIntegers: true });
        return {
            exec: (sql) => db.exec(sql),
            prepare: (sql) => {
                const statement = db.prepare(sql);
                return {
                    columnNames: statement.columnNames,
                    declaredTypes: statement.declaredTypes,
                    values: (args) => statement.values(...args),
                    run: (args) => statement.run(...args),
                };
            },
            close: () => db.close(),
        };
    }
    const sqlite = await import("node:sqlite");
    const DatabaseSync = sqlite.DatabaseSync as unknown as new (path: string, options: { readBigInts: boolean }) => NodeSqliteDatabase;
    const db = new DatabaseSync(path, { readBigInts: true });
    return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => {
            const statement = db.prepare(sql);
            const columns = statement.columns();
            statement.setReturnArrays(true);
            return {
                columnNames: columns.map((column) => column.name),
                declaredTypes: columns.map((column) => column.type),
                values: (args) => statement.all(...args),
                run: (args) => {
                    const result = statement.run(...args);
                    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
                },
            };
        },
        close: () => db.close(),
    };
}

export interface SqliteConnectionOptions {
    /** Filesystem path (or `:memory:`). */
    readonly path: string;
    /** Connections the pool may open (Rust: `connection_limit`). */
    readonly connectionLimit: number;
    /** How long a statement waits for a busy database before failing (the `busy_timeout` contract). */
    readonly busyTimeoutMs: number;
}

/** Parses a Prisma SQLite `file:` URL into its path and `connection_limit` (default 1). */
export function parseSqliteDatabaseUrl(rawUrl: string): Readonly<{ path: string; connectionLimit: number }> {
    const queryAt = rawUrl.indexOf("?");
    const location = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
    const params = new URLSearchParams(queryAt < 0 ? "" : rawUrl.slice(queryAt + 1));
    if (!location.startsWith("file:")) {
        throw new Error("SQLite DATABASE_URL must start with file:");
    }
    const path = location.startsWith("file://") ? fileURLToPath(location) : location.slice("file:".length);
    const connectionLimit = Number(params.get("connection_limit") ?? "");
    return { path, connectionLimit: Number.isSafeInteger(connectionLimit) && connectionLimit > 0 ? connectionLimit : 1 };
}

const DECLARED_COLUMN_TYPES: Readonly<Record<string, ColumnType>> = {
    DECIMAL: ColumnTypeEnum.Numeric,
    FLOAT: ColumnTypeEnum.Float,
    DOUBLE: ColumnTypeEnum.Double,
    "DOUBLE PRECISION": ColumnTypeEnum.Double,
    NUMERIC: ColumnTypeEnum.Double,
    REAL: ColumnTypeEnum.Double,
    TINYINT: ColumnTypeEnum.Int32,
    SMALLINT: ColumnTypeEnum.Int32,
    MEDIUMINT: ColumnTypeEnum.Int32,
    INT: ColumnTypeEnum.Int32,
    INTEGER: ColumnTypeEnum.Int32,
    SERIAL: ColumnTypeEnum.Int32,
    INT2: ColumnTypeEnum.Int32,
    BIGINT: ColumnTypeEnum.Int64,
    "UNSIGNED BIG INT": ColumnTypeEnum.Int64,
    INT8: ColumnTypeEnum.Int64,
    DATETIME: ColumnTypeEnum.DateTime,
    TIMESTAMP: ColumnTypeEnum.DateTime,
    TIME: ColumnTypeEnum.Time,
    DATE: ColumnTypeEnum.Date,
    TEXT: ColumnTypeEnum.Text,
    CLOB: ColumnTypeEnum.Text,
    CHARACTER: ColumnTypeEnum.Text,
    VARCHAR: ColumnTypeEnum.Text,
    "VARYING CHARACTER": ColumnTypeEnum.Text,
    NCHAR: ColumnTypeEnum.Text,
    "NATIVE CHARACTER": ColumnTypeEnum.Text,
    NVARCHAR: ColumnTypeEnum.Text,
    BLOB: ColumnTypeEnum.Bytes,
    BOOLEAN: ColumnTypeEnum.Boolean,
    JSONB: ColumnTypeEnum.Json,
};

function inferColumnType(value: unknown): ColumnType {
    switch (typeof value) {
        case "string": return ColumnTypeEnum.Text;
        case "bigint": return ColumnTypeEnum.Int64;
        // Integers arrive as bigint (safe integers), so a number is a REAL.
        case "number": return ColumnTypeEnum.UnknownNumber;
        default: return value instanceof Uint8Array ? ColumnTypeEnum.Bytes : ColumnTypeEnum.Text;
    }
}

function resolveColumnTypes(declaredTypes: readonly (string | null)[], rows: readonly unknown[][]): ColumnType[] {
    return declaredTypes.map((declared, index) => {
        const mapped = declared ? DECLARED_COLUMN_TYPES[declared.toUpperCase()] : undefined;
        if (mapped !== undefined) return mapped;
        // Expressions and undeclared columns take the type of their first non-null value.
        for (const row of rows) {
            if (row[index] !== null) return inferColumnType(row[index]);
        }
        return ColumnTypeEnum.Int32;
    });
}

// SQLite's own `CURRENT_TIMESTAMP` text (UTC, no zone): Date parses it as local time otherwise.
const SQLITE_UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

function mapCell(value: unknown, columnType: ColumnType): unknown {
    if (value === null) return null;
    switch (columnType) {
        case ColumnTypeEnum.DateTime:
        case ColumnTypeEnum.Date:
            if (typeof value === "bigint" || typeof value === "number") return new Date(Number(value)).toISOString();
            if (typeof value === "string") {
                const match = SQLITE_UTC_TIMESTAMP.exec(value);
                return match ? `${match[1]}T${match[2]}Z` : value;
            }
            return value;
        case ColumnTypeEnum.Boolean:
            if (typeof value === "bigint" || typeof value === "number") return Number(value) !== 0;
            return value;
        case ColumnTypeEnum.Int32:
        case ColumnTypeEnum.Int64:
            if (typeof value === "number" && !Number.isInteger(value)) return Math.trunc(value);
            break;
        default:
            break;
    }
    if (typeof value === "bigint") {
        const asNumber = Number(value);
        return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    return value;
}

// Integer-valued numbers bind as int64 (bigint), as the Rust engine and bun:sqlite bind them.
// node:sqlite binds every JS number as a REAL, which a TEXT-affinity column stores as '1.0'.
function bindNumber(value: number): SqliteBindValue {
    return Number.isSafeInteger(value) ? BigInt(value) : value;
}

function mapArg(arg: unknown, argType: ArgType | undefined): SqliteBindValue {
    if (arg === null || arg === undefined) return null;
    const scalarType = argType?.scalarType;
    if (typeof arg === "boolean") return arg ? 1n : 0n;
    if (arg instanceof Date) return BigInt(arg.getTime());
    if (typeof arg === "string") {
        switch (scalarType) {
            case "int":
            case "bigint": return BigInt(arg);
            case "float":
            case "decimal": return Number.parseFloat(arg);
            case "datetime": return BigInt(new Date(arg).getTime());
            case "bytes": return Buffer.from(arg, "base64");
            default: return arg;
        }
    }
    if (typeof arg === "number") return bindNumber(arg);
    if (typeof arg === "bigint" || arg instanceof Uint8Array) return arg;
    // JSON arguments are serialized by the query compiler; anything else is a contract break.
    throw new DriverAdapterError({ kind: "InvalidInputValue", message: `Unsupported SQLite argument of type ${typeof arg}` });
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_NOTNULL = 1299;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_TRIGGER = 1811;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** Extended result code from `bun:sqlite` (`errno`) or `node:sqlite` (`errcode`). */
function readSqliteExtendedCode(error: unknown): number | null {
    if (!error || typeof error !== "object") return null;
    const record = error as { errno?: unknown; errcode?: unknown };
    const code = typeof record.errcode === "number" ? record.errcode : record.errno;
    return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function isSqliteBusy(error: unknown): boolean {
    const code = readSqliteExtendedCode(error);
    return code !== null && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED);
}

function constraintFields(message: string): string[] | undefined {
    return message.split("constraint failed: ").at(1)?.split(", ").map((field) => field.split(".").pop() ?? field);
}

function mapSqliteError(error: unknown): MappedError {
    const extendedCode = readSqliteExtendedCode(error) ?? 1;
    const message = error instanceof Error ? error.message : String(error);
    const originalCode = String(extendedCode);
    const base = { originalCode, originalMessage: message };
    switch (extendedCode) {
        case SQLITE_CONSTRAINT_UNIQUE:
        case SQLITE_CONSTRAINT_PRIMARYKEY: {
            const fields = constraintFields(message);
            return { ...base, kind: "UniqueConstraintViolation", ...(fields ? { constraint: { fields } } : {}) };
        }
        case SQLITE_CONSTRAINT_NOTNULL: {
            const fields = constraintFields(message);
            return { ...base, kind: "NullConstraintViolation", ...(fields ? { constraint: { fields } } : {}) };
        }
        case SQLITE_CONSTRAINT_FOREIGNKEY:
        case SQLITE_CONSTRAINT_TRIGGER:
            return { ...base, kind: "ForeignKeyConstraintViolation", constraint: { foreignKey: {} } };
        default:
            break;
    }
    if ((extendedCode & 0xff) === SQLITE_BUSY || (extendedCode & 0xff) === SQLITE_LOCKED) {
        return { ...base, kind: "SocketTimeout" };
    }
    if (message.startsWith("no such table")) return { ...base, kind: "TableDoesNotExist", table: message.split(": ").at(1) };
    if (message.startsWith("no such column")) return { ...base, kind: "ColumnNotFound", column: message.split(": ").at(1) };
    if (message.includes("has no column named ")) {
        return { ...base, kind: "ColumnNotFound", column: message.split("has no column named ").at(1) };
    }
    return { ...base, kind: "sqlite", extendedCode, message };
}

// SQLite's default busy-handler delays (sqlite3.c `sqliteDefaultBusyCallback`), in ms.
const BUSY_DELAYS_MS = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100] as const;

/**
 * Runs one attempt until it stops failing with SQLITE_BUSY/LOCKED, waiting asynchronously on
 * SQLite's back-off schedule for up to `busyTimeoutMs` from the first busy failure (as
 * `busy_timeout` counts); other errors, and a busy past the deadline, map to Prisma's kinds.
 */
async function retryWhileBusy<T>(busyTimeoutMs: number, attempt: () => T | Promise<T>): Promise<T> {
    let deadlineAtMs: number | null = null;
    for (let retry = 0; ; retry += 1) {
        try {
            return await attempt();
        } catch (error) {
            if (error instanceof DriverAdapterError) throw error;
            deadlineAtMs ??= Date.now() + busyTimeoutMs;
            const delayMs = BUSY_DELAYS_MS[Math.min(retry, BUSY_DELAYS_MS.length - 1)]!;
            if (!isSqliteBusy(error) || Date.now() + delayMs > deadlineAtMs) {
                throw new DriverAdapterError(mapSqliteError(error));
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

class SqliteConnection {
    constructor(readonly db: SqliteBindingDatabase, private readonly busyTimeoutMs: number) {}

    /** Runs one statement on this held connection (inside a transaction), waiting while the database is busy. */
    execute<T>(statement: (db: SqliteBindingDatabase) => T): Promise<T> {
        return retryWhileBusy(this.busyTimeoutMs, () => statement(this.db));
    }

    close(): void {
        this.db.close();
    }
}

export interface SqlitePoolStats {
    readonly open: number;
    readonly idle: number;
    readonly waiting: number;
}

type PooledConnection = Readonly<{ connection: SqliteConnection; release: () => void }>;

class SqliteConnectionPool {
    private readonly admission: AsyncLock;
    private readonly idle: SqliteConnection[] = [];
    private readonly opened: SqliteConnection[] = [];
    private waiting = 0;

    constructor(private readonly options: SqliteConnectionOptions, first: SqliteConnection) {
        this.admission = new AsyncLock(options.connectionLimit);
        this.idle.push(first);
        this.opened.push(first);
    }

    /** Holds one connection exclusively until `release` runs; opens connections lazily up to the limit. */
    async acquire(): Promise<PooledConnection> {
        this.waiting += 1;
        const releaseAdmission = await new Promise<() => void>((admitted) => {
            void this.admission.inLock(() => new Promise<void>((release) => admitted(release)));
        }).finally(() => { this.waiting -= 1; });
        try {
            let connection = this.idle.pop();
            if (!connection) {
                connection = await openSqliteConnection(this.options);
                this.opened.push(connection);
            }
            const held = connection;
            return { connection: held, release: () => { this.idle.push(held); releaseAdmission(); } };
        } catch (error) {
            releaseAdmission();
            throw error;
        }
    }

    /**
     * Runs one autocommit statement. Between busy attempts the connection goes back to the pool:
     * it holds no SQLite state then, so a statement (or a transaction about to begin) that waits
     * for another connection's write lock never queues the pool's other statements behind it.
     */
    runStatement<T>(statement: (db: SqliteBindingDatabase) => T): Promise<T> {
        return retryWhileBusy(this.options.busyTimeoutMs, async () => {
            const { connection, release } = await this.acquire();
            try {
                return statement(connection.db);
            } finally {
                release();
            }
        });
    }

    /** Takes a connection whose `BEGIN IMMEDIATE` succeeded; it stays held until the transaction ends. */
    beginImmediate(): Promise<PooledConnection> {
        return retryWhileBusy(this.options.busyTimeoutMs, async () => {
            const held = await this.acquire();
            try {
                held.connection.db.exec("BEGIN IMMEDIATE");
                return held;
            } catch (error) {
                held.release();
                throw error;
            }
        });
    }

    stats(): SqlitePoolStats {
        return { open: this.opened.length, idle: this.idle.length, waiting: this.waiting };
    }

    /** Waits for every connection to come back, then closes them. */
    async close(): Promise<void> {
        const held = await Promise.all(Array.from({ length: this.options.connectionLimit }, () => this.acquire()));
        for (const connection of this.opened) connection.close();
        this.opened.length = 0;
        this.idle.length = 0;
        for (const entry of held) entry.release();
    }
}

async function openSqliteConnection(options: SqliteConnectionOptions): Promise<SqliteConnection> {
    const db = await openSqliteBinding(options.path);
    try {
        // Waiting happens in SqliteConnection.execute, off the JavaScript thread's critical path.
        db.exec("PRAGMA busy_timeout=0;");
        // The Rust engine enabled foreign keys on every SQLite connection it opened.
        db.exec("PRAGMA foreign_keys=ON;");
    } catch (error) {
        db.close();
        throw new DriverAdapterError(mapSqliteError(error));
    }
    return new SqliteConnection(db, options.busyTimeoutMs);
}

function queryRawStatement(query: SqlQuery): (db: SqliteBindingDatabase) => SqlResultSet {
    return (db) => {
        const args = query.args.map((arg, index) => mapArg(arg, query.argTypes[index]));
        const statement = db.prepare(query.sql);
        if (statement.columnNames.length === 0) {
            statement.run(args);
            return { columnNames: [], columnTypes: [], rows: [] };
        }
        const rows = statement.values(args);
        const columnTypes = resolveColumnTypes(statement.declaredTypes, rows);
        return {
            columnNames: [...statement.columnNames],
            columnTypes,
            rows: rows.map((row) => row.map((cell, index) => mapCell(cell, columnTypes[index]!))),
        };
    };
}

function executeRawStatement(query: SqlQuery): (db: SqliteBindingDatabase) => number {
    return (db) => {
        const args = query.args.map((arg, index) => mapArg(arg, query.argTypes[index]));
        return db.prepare(query.sql).run(args).changes;
    };
}

const ADAPTER_NAME = "@happier-dev/server-sqlite";

class SqliteTransaction implements Transaction {
    readonly provider = "sqlite";
    readonly adapterName = ADAPTER_NAME;
    // Prisma sends COMMIT/ROLLBACK through executeRaw before calling commit()/rollback().
    readonly options = { usePhantomQuery: false };

    constructor(private readonly connection: SqliteConnection, private readonly release: () => void) {}

    queryRaw(query: SqlQuery): Promise<SqlResultSet> {
        return this.connection.execute(queryRawStatement(query));
    }

    executeRaw(query: SqlQuery): Promise<number> {
        return this.connection.execute(executeRawStatement(query));
    }

    async commit(): Promise<void> {
        this.release();
    }

    async rollback(): Promise<void> {
        this.release();
    }

    async createSavepoint(name: string): Promise<void> {
        await this.connection.execute((db) => db.exec(`SAVEPOINT ${name}`));
    }

    async rollbackToSavepoint(name: string): Promise<void> {
        await this.connection.execute((db) => db.exec(`ROLLBACK TO ${name}`));
    }

    async releaseSavepoint(name: string): Promise<void> {
        await this.connection.execute((db) => db.exec(`RELEASE SAVEPOINT ${name}`));
    }
}

class SqliteDriverAdapter implements SqlDriverAdapter {
    readonly provider = "sqlite";
    readonly adapterName = ADAPTER_NAME;

    constructor(private readonly pool: SqliteConnectionPool) {}

    queryRaw(query: SqlQuery): Promise<SqlResultSet> {
        return this.pool.runStatement(queryRawStatement(query));
    }

    executeRaw(query: SqlQuery): Promise<number> {
        return this.pool.runStatement(executeRawStatement(query));
    }

    executeScript(script: string): Promise<void> {
        return this.pool.runStatement((db) => db.exec(script));
    }

    async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
        if (isolationLevel && isolationLevel !== "SERIALIZABLE") {
            throw new DriverAdapterError({ kind: "InvalidIsolationLevel", level: isolationLevel });
        }
        // IMMEDIATE takes the write lock up front, as the Rust engine's SQLite transactions did,
        // so a transaction never fails mid-way upgrading a read lock.
        const { connection, release } = await this.pool.beginImmediate();
        return new SqliteTransaction(connection, release);
    }

    dispose(): Promise<void> {
        return this.pool.close();
    }
}

/** Prisma driver-adapter factory for a server SQLite database. */
export class SqliteDriverAdapterFactory implements SqlDriverAdapterFactory {
    readonly provider = "sqlite";
    readonly adapterName = ADAPTER_NAME;

    private pool: SqliteConnectionPool | null = null;

    constructor(private readonly options: SqliteConnectionOptions) {}

    async connect(): Promise<SqlDriverAdapter> {
        // The first connection opens eagerly so an unreadable path fails at connect.
        const pool = new SqliteConnectionPool(this.options, await openSqliteConnection(this.options));
        this.pool = pool;
        return new SqliteDriverAdapter(pool);
    }

    /** Pool state for metrics; null before the client first connects. */
    poolStats(): SqlitePoolStats | null {
        return this.pool?.stats() ?? null;
    }
}
