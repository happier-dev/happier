const PROVIDER_ALIASES = new Map([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['pglite', 'pglite'],
  ['sqlite', 'sqlite'],
]);

const SERVER_COMPONENTS = new Set(['happier-server', 'happier-server-light']);
const SUPPORTED_PROVIDERS = Object.freeze(['postgres', 'mysql', 'pglite', 'sqlite']);

const COMPONENT_DEFAULTS = {
  'happier-server': 'postgres',
  'happier-server-light': 'sqlite',
};

export function resolveEffectiveDbProvider({ serverComponentName, env = {} } = {}) {
  if (!SERVER_COMPONENTS.has(serverComponentName)) {
    return {
      ok: false,
      reason: 'unsupported_server_component',
      serverComponentName,
      supportedServerComponents: [...SERVER_COMPONENTS],
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
    : PROVIDER_ALIASES.get(input);

  if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
    return {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName,
      source,
      input,
      supportedProviders: [...SUPPORTED_PROVIDERS],
    };
  }

  return { ok: true, provider, source };
}

export function resolveEffectiveDbProviderTransition({
  previousServerComponentName,
  nextServerComponentName,
  env = {},
} = {}) {
  void previousServerComponentName;
  const effective = resolveEffectiveDbProvider({ serverComponentName: nextServerComponentName, env });
  if (!effective.ok) return effective;

  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  if (effective.provider === 'mysql' && !databaseUrl) {
    return { ok: false, reason: 'missing_mysql_database_url', provider: 'mysql' };
  }

  let databaseProtocol = '';
  if (databaseUrl) {
    try {
      databaseProtocol = new URL(databaseUrl).protocol;
    } catch {
      databaseProtocol = '';
    }
  }
  if (effective.provider === 'mysql' && databaseProtocol !== 'mysql:') {
    return { ok: false, reason: 'invalid_mysql_database_url', provider: 'mysql' };
  }
  const postgresProtocolValid = ['postgres:', 'postgresql:'].includes(databaseProtocol);
  if (
    effective.provider === 'postgres'
    && nextServerComponentName === 'happier-server-light'
    && !databaseUrl
  ) {
    return { ok: false, reason: 'missing_postgres_database_url', provider: 'postgres' };
  }
  if (
    effective.provider === 'postgres'
    && nextServerComponentName === 'happier-server-light'
    && !postgresProtocolValid
  ) {
    return { ok: false, reason: 'invalid_postgres_database_url', provider: 'postgres' };
  }

  const databaseUrlCompatible = databaseUrl && (
    (effective.provider === 'postgres' && postgresProtocolValid)
    || (effective.provider === 'mysql' && databaseProtocol === 'mysql:')
    || (effective.provider === 'sqlite' && databaseProtocol === 'file:')
  );

  return {
    ok: true,
    provider: effective.provider,
    databaseUrl: databaseUrlCompatible ? databaseUrl : null,
    removeDatabaseUrl: Boolean(databaseUrl) && !databaseUrlCompatible,
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
  return effective.provider;
}
