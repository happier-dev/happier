/** @moduleRealm daemon */
import { createRequire } from 'node:module';

export type SqliteStatementSync = Readonly<{
    get: (...params: readonly unknown[]) => unknown;
    all: (...params: readonly unknown[]) => unknown[];
    iterate: (...params: readonly unknown[]) => Iterable<unknown>;
    run: (...params: readonly unknown[]) => unknown;
}>;

export type SqliteDatabaseSync = Readonly<{
    exec: (sql: string) => void;
    prepare: (sql: string) => SqliteStatementSync;
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
    return new (ctor as new (path: string, options?: typeof nativeOptions) => SqliteDatabaseSync)(filePath, nativeOptions);
}
