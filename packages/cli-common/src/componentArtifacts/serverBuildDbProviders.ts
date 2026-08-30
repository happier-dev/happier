export type ServerBuildDbProvider = 'postgres' | 'mysql' | 'sqlite';

const ALL_SERVER_BUILD_DB_PROVIDERS: readonly ServerBuildDbProvider[] = ['postgres', 'mysql', 'sqlite'];

export function resolveServerBuildDbProviders(rawInput: string | null | undefined): Set<ServerBuildDbProvider> {
  const raw = String(rawInput ?? '').trim();
  if (!raw) return new Set(ALL_SERVER_BUILD_DB_PROVIDERS);

  const tokens = raw
    .split(/[|,]/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return new Set(ALL_SERVER_BUILD_DB_PROVIDERS);

  const providers = new Set<ServerBuildDbProvider>();
  for (const token of tokens) {
    if (token === 'all') return new Set(ALL_SERVER_BUILD_DB_PROVIDERS);
    if (token === 'postgres' || token === 'postgresql' || token === 'pglite') {
      providers.add('postgres');
      continue;
    }
    if (token === 'mysql' || token === 'sqlite') {
      providers.add(token);
      continue;
    }
    throw new Error(
      `Unsupported HAPPIER_BUILD_DB_PROVIDERS token: ${token}. Supported: postgres|pglite|mysql|sqlite|all`,
    );
  }

  // The server imports the default Postgres Prisma client in every runtime projection.
  providers.add('postgres');
  return providers;
}

export function resolveServerBuildDbProvidersFromEnv(env: NodeJS.ProcessEnv): Set<ServerBuildDbProvider> {
  return resolveServerBuildDbProviders(
    env.HAPPIER_BUILD_DB_PROVIDERS ?? env.HAPPY_BUILD_DB_PROVIDERS,
  );
}
