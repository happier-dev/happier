import { createRequire } from 'node:module';

export type SqliteStatementSync = Readonly<{
  get: (...params: readonly unknown[]) => unknown;
  all: (...params: readonly unknown[]) => unknown[];
  run: (...params: readonly unknown[]) => unknown;
}>;

export type SqliteDatabaseSync = Readonly<{
  function: (name: string, options: Readonly<{ deterministic: boolean }>, fn: (value: unknown) => string) => unknown;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatementSync;
  close: () => void;
}>;

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

export function openSqliteDatabaseSync(
  filePath: string,
  options?: Readonly<{ readOnly?: boolean }>,
): SqliteDatabaseSync {
  const require = createRequire(import.meta.url);
  const moduleName = isBunRuntime() ? 'bun:sqlite' : 'node:sqlite';

  const mod = require(moduleName) as unknown;
  if (!mod || typeof mod !== 'object') {
    throw new Error(`Failed to load sqlite module: ${moduleName}`);
  }

  const ctor = (isBunRuntime()
    ? (mod as { Database?: unknown }).Database
    : (mod as { DatabaseSync?: unknown }).DatabaseSync) as unknown;

  if (typeof ctor !== 'function') {
    throw new Error(`Failed to resolve sqlite Database constructor from ${moduleName}`);
  }

  const Database = ctor as new (path: string, options?: unknown) => SqliteDatabaseSync;
  if (options?.readOnly !== true) return new Database(filePath);
  return new Database(filePath, isBunRuntime() ? { readonly: true, create: false } : { readOnly: true });
}
