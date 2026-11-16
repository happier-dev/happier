import type { SqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';

export function registerMemorySearchFunctions(db: SqliteDatabaseSync): void {
  // SQLite's built-in lower() only folds ASCII; queries and the app use Unicode casing.
  db.function('memory_search_lower', { deterministic: true }, (value: unknown) => (
    typeof value === 'string' ? value.toLocaleLowerCase() : ''
  ));
}
