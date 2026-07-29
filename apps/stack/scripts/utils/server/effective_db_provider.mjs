const PROVIDER_ALIASES = new Map([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['pglite', 'pglite'],
  ['sqlite', 'sqlite'],
]);

const COMPONENT_PROVIDERS = {
  'happier-server': ['postgres', 'mysql'],
  'happier-server-light': ['sqlite', 'pglite'],
};

const COMPONENT_DEFAULTS = {
  'happier-server': 'postgres',
  'happier-server-light': 'sqlite',
};

export function resolveEffectiveDbProvider({ serverComponentName, env = {} } = {}) {
  const supportedProviders = COMPONENT_PROVIDERS[serverComponentName];
  if (!supportedProviders) {
    return {
      ok: false,
      reason: 'unsupported_server_component',
      serverComponentName,
      supportedServerComponents: Object.keys(COMPONENT_PROVIDERS),
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

  if (!provider || !supportedProviders.includes(provider)) {
    return {
      ok: false,
      reason: 'unsupported_db_provider',
      serverComponentName,
      source,
      input,
      supportedProviders: [...supportedProviders],
    };
  }

  return { ok: true, provider, source };
}

export function resolveEffectiveDbProviderTransition({
  previousServerComponentName,
  nextServerComponentName,
  env = {},
} = {}) {
  let effective = resolveEffectiveDbProvider({ serverComponentName: nextServerComponentName, env });
  if (!effective.ok && previousServerComponentName !== nextServerComponentName) {
    const previous = resolveEffectiveDbProvider({ serverComponentName: previousServerComponentName, env });
    if (previous.ok) {
      effective = resolveEffectiveDbProvider({ serverComponentName: nextServerComponentName, env: {} });
    }
  }
  if (!effective.ok) return effective;

  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  if (effective.provider === 'mysql' && !databaseUrl) {
    return { ok: false, reason: 'missing_mysql_database_url', provider: 'mysql' };
  }

  let postgresUrl = false;
  if (databaseUrl) {
    try {
      postgresUrl = ['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol);
    } catch {
      postgresUrl = false;
    }
  }

  return {
    ok: true,
    provider: effective.provider,
    databaseUrl: effective.provider === 'mysql' ? databaseUrl : null,
    removeDatabaseUrl: Boolean(databaseUrl) && (
      nextServerComponentName === 'happier-server-light' ||
      (effective.provider === 'postgres' && !postgresUrl)
    ),
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
