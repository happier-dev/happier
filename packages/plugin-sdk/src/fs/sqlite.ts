/** @moduleRealm daemon */
import { createRequire } from 'node:module';

export type SqliteStatementSync = Readonly<{
    get: (...params: readonly unknown[]) => unknown;
    all: (...params: readonly unknown[]) => unknown[];
    iterate: (...params: readonly unknown[]) => Iterable<unknown>;
    run: (...params: readonly unknown[]) => unknown;
    /** Declared metadata, available before execution and for empty results. */
    columns: () => Array<{ name: string; type: string | null }>;
    /** Ordered native values; INTEGER values are always lossless bigint. */
    values: (...params: readonly unknown[]) => unknown[][];
}>;

// Runtime-native methods are normalized here, never in a plugin's transport.
type NativeStatement = Omit<SqliteStatementSync, 'columns' | 'values'> & {
    columns?: () => Array<{ name: string; type: string | null }>;
    values?: (...params: readonly unknown[]) => unknown[][];
    setReturnArrays?: (enabled: boolean) => void;
    setReadBigInts?: (enabled: boolean) => void;
    setAllowBareNamedParameters?: (enabled: boolean) => void;
    safeIntegers?: (enabled: boolean) => void;
    columnNames?: string[];
    declaredTypes?: Array<string | null>;
};

export type SqliteDatabaseSync = Readonly<{
    exec: (sql: string) => void;
    /** Optional prefixed SQLite parameter names by one-based bind index. With
     * this map, callers pass all values in ordinary SQLite bind index order. */
    prepare: (sql: string, options?: Readonly<{ namedParameters?: ReadonlyMap<number, string> }>) => SqliteStatementSync;
    close: () => void;
}>;

/** The host runtime selects its native provider lazily, shared by host and plugin callers. */
export function openSqliteDatabaseSync(
    filePath: string,
    options?: Readonly<{ readOnly?: boolean }>,
): SqliteDatabaseSync {
    const require = createRequire(import.meta.url);
    const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
    // A literal node:sqlite branch is hoisted by pkgroll and prevents the
    // Bun-compiled CLI from starting before this operation is invoked.
    const moduleName = [isBunRuntime ? 'bun' : 'node', 'sqlite'].join(':');
    const mod = require(moduleName) as unknown;
    if (!mod || typeof mod !== 'object') {
        throw new Error(`Failed to load sqlite module: ${moduleName}`);
    }
    const ctor = isBunRuntime
        ? (mod as { Database?: unknown }).Database
        : (mod as { DatabaseSync?: unknown }).DatabaseSync;
    if (typeof ctor !== 'function') {
        throw new Error(`Failed to resolve sqlite Database constructor from ${moduleName}`);
    }
    const nativeOptions: Readonly<{ readonly?: boolean; readOnly?: boolean }> = options?.readOnly === true
        ? (isBunRuntime ? { readonly: true } : { readOnly: true })
        : {};
    const native = new (ctor as new (path: string, options?: typeof nativeOptions) => {
        exec: (sql: string) => void; close: () => void; prepare: (sql: string) => NativeStatement;
    })(filePath, nativeOptions);
    return {
        exec: sql => native.exec(sql), close: () => native.close(),
        prepare(sql, options) {
            const statement = native.prepare(sql);
            const nodeNamedParameters = isBunRuntime ? undefined : options?.namedParameters;
            if (nodeNamedParameters) statement.setAllowBareNamedParameters!(false);
            const bind = (params: readonly unknown[]) => {
                if (!nodeNamedParameters) return params;
                // Node skips named slots when binding positional arguments.
                // Preserve numbered slots and gaps in the remaining arguments.
                const named: Record<string, unknown> = Object.create(null);
                const positional: unknown[] = [];
                for (const [offset, value] of params.entries()) {
                    const name = nodeNamedParameters.get(offset + 1);
                    if (name === undefined) positional.push(value);
                    else named[name] = value;
                }
                return [named, ...positional];
            };
            return {
                get: (...params) => statement.get(...bind(params)),
                all: (...params) => statement.all(...bind(params)),
                iterate: (...params) => statement.iterate(...bind(params)),
                run: (...params) => statement.run(...bind(params)),
                columns: () => isBunRuntime
                    ? statement.columnNames!.map((name, index) => ({ name, type: statement.declaredTypes![index] ?? null }))
                    : statement.columns!().map(({ name, type }) => ({ name, type })),
                values(...params) {
                    if (isBunRuntime) {
                        statement.safeIntegers!(true);
                        try { return statement.values!(...params); }
                        finally { statement.safeIntegers!(false); }
                    }
                    statement.setReadBigInts!(true);
                    statement.setReturnArrays!(true);
                    try { return statement.all(...bind(params)) as unknown[][]; }
                    finally { statement.setReadBigInts!(false); statement.setReturnArrays!(false); }
                },
            };
        },
    };
}
