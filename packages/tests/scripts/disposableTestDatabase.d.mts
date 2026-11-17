export function prepareDisposableTestDatabase(input: Readonly<{
  databaseName: string;
  dbProvider: 'postgres' | 'mysql';
  sourceDatabaseUrl: string;
  reuseExisting?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}>): string | undefined;
