const PROVIDER_ALIASES = new Map([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['pglite', 'pglite'],
  ['sqlite', 'sqlite'],
]);

const SUPPORTED_PROVIDERS = ['postgres', 'mysql', 'pglite', 'sqlite'];

const COMPONENT_DEFAULTS = {
  'happier-server': 'postgres',
  'happier-server-light': 'sqlite',
};

export function normalizeDbProvider(input) {
  return PROVIDER_ALIASES.get(String(input ?? '').trim().toLowerCase()) ?? null;
}

export function resolveEffectiveDbProvider({ serverComponentName, env = {} } = {}) {
  if (!Object.hasOwn(COMPONENT_DEFAULTS, serverComponentName)) {
    return {
      ok: false,
      reason: 'unsupported_server_component',
      serverComponentName,
      supportedServerComponents: Object.keys(COMPONENT_DEFAULTS),
    };
  }

  const source = env.HAPPIER_DB_PROVIDER != null
    ? 'HAPPIER_DB_PROVIDER'
    : env.HAPPY_DB_PROVIDER != null
      ? 'HAPPY_DB_PROVIDER'
      : 'default';
  const input = source === 'default' ? '' : String(env[source]).trim().toLowerCase();
  const provider = source === 'default'
    ? COMPONENT_DEFAULTS[serverComponentName]
    : normalizeDbProvider(input);

  if (!provider) {
    return {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName,
      source,
      input,
      supportedProviders: [...SUPPORTED_PROVIDERS],
    };
  }

  return {
    ok: true,
    provider,
    source,
  };
}

export function resolveEffectiveDbProviderTransition({
  previousServerComponentName,
  nextServerComponentName,
  env = {},
} = {}) {
  const effective = resolveEffectiveDbProvider({ serverComponentName: nextServerComponentName, env });
  if (!effective.ok) return effective;

  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  if (effective.provider === 'mysql' && !databaseUrl) {
    return { ok: false, reason: 'missing_mysql_database_url', provider: 'mysql' };
  }
  const databaseAuthority = resolveDbProviderDatabaseUrl({ provider: effective.provider, databaseUrl });
  if (effective.provider === 'mysql' && !databaseAuthority.databaseUrl) {
    return { ok: false, reason: 'invalid_mysql_database_url', provider: 'mysql' };
  }
  if (effective.provider === 'postgres' && nextServerComponentName === 'happier-server-light') {
    if (!databaseUrl) {
      return { ok: false, reason: 'missing_postgres_database_url', provider: 'postgres' };
    }
    if (!databaseAuthority.databaseUrl) {
      return { ok: false, reason: 'invalid_postgres_database_url', provider: 'postgres' };
    }
  }
  return {
    ok: true,
    provider: effective.provider,
    ...databaseAuthority,
  };
}

export function resolveDbProviderDatabaseUrl({ provider, databaseUrl } = {}) {
  const normalizedDatabaseUrl = String(databaseUrl ?? '').trim();
  let protocol = '';
  if (normalizedDatabaseUrl) {
    try {
      protocol = new URL(normalizedDatabaseUrl).protocol;
    } catch {
      protocol = '';
    }
  }
  const compatibleDatabaseUrl = (
    (provider === 'postgres' && ['postgres:', 'postgresql:'].includes(protocol)) ||
    (provider === 'mysql' && protocol === 'mysql:') ||
    (provider === 'sqlite' && protocol === 'file:')
  );
  return {
    databaseUrl: compatibleDatabaseUrl ? normalizedDatabaseUrl : null,
    removeDatabaseUrl: Boolean(normalizedDatabaseUrl) && !compatibleDatabaseUrl,
  };
}

export function isCanonicalManagedPostgresAuthority({ databaseUrl, env = {} } = {}) {
  const pgPort = Number(String(env.HAPPIER_STACK_PG_PORT ?? '').trim());
  const pgUser = String(env.HAPPIER_STACK_PG_USER ?? '').trim();
  const pgPassword = String(env.HAPPIER_STACK_PG_PASSWORD ?? '').trim();
  const pgDb = String(env.HAPPIER_STACK_PG_DATABASE ?? '').trim();
  if (!Number.isInteger(pgPort) || pgPort < 1 || pgPort > 65535 || !pgUser || !pgPassword || !pgDb) return false;
  const canonicalUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;
  return String(databaseUrl ?? '').trim() === canonicalUrl;
}

export function applyEffectiveDbProviderEnv({ serverComponentName, env = {}, targetEnv = env } = {}) {
  const effective = resolveEffectiveDbProvider({ serverComponentName, env });
  if (!effective.ok) {
    if (effective.reason === 'unsupported_server_component') {
      throw new Error(
        `Unsupported server component ${JSON.stringify(effective.serverComponentName)} ` +
        `(supported: ${effective.supportedServerComponents.join(', ')})`,
      );
    }
    throw new Error(
      `Unsupported DB provider ${JSON.stringify(effective.input)} for ${serverComponentName} ` +
      `(supported: ${effective.supportedProviders.join(', ')})`,
    );
  }

  targetEnv.HAPPIER_DB_PROVIDER = effective.provider;
  targetEnv.HAPPY_DB_PROVIDER = effective.provider;
  return effective.provider;
}
