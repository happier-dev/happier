import { resolveStackSocketAdapterScope } from '../server/server_env.mjs';

import { resolveEffectiveDbProvider } from "../server/effective_db_provider.mjs";

const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS = new Set([
  // Preserve an explicit host allocator choice; never impose an arena limit here.
  'MALLOC_ARENA_MAX',
  'HAPPIER_SOCKET_ADAPTER_SCOPE',
  'HAPPIER_STACK_SHARED_DB_SOURCE_STACK',
  'HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE',
  'HAPPIER_SQLITE_AUTO_MIGRATE',
  'HAPPIER_STACK_MIGRATE_MODE',
  'METRICS_ENABLED',
  // The application origin mailed links (verification, reset, invitations) are rendered on.
  'HAPPIER_WEBAPP_URL',
  // Publishing requires the service operator's public report contact on the serving host.
  'HAPPIER_PUBLIC_PROFILE_REPORT_URL',
  'HAPPIER_SQLITE_BUSY_TIMEOUT_MS',
  'HAPPIER_SQLITE_CONNECTION_LIMIT',
  // A Stack's Postgres pool budget (overrides DATABASE_URL connection_limit) belongs to its server too.
  'HAPPIER_DB_CONNECTION_LIMIT',
  // The Stack's chosen server log level (resolved by server_env.mjs) applies wherever its server runs.
  'HAPPIER_STACK_SERVER_LOG_LEVEL',
  'HAPPIER_SERVER_LOG_LEVEL',
  'HAPPIER_SERVER_LOG_FORMAT',
  'HAPPIER_WEB_LATENCY_TRACE',
]);
const REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES = [
  // Server feature configuration is non-secret; preserve the Stack's policy wherever it runs.
  'HAPPIER_FEATURE_',
  'HAPPIER_SERVER_RETENTION__',
  // Auth mail delivery and the email/password method: a Stack's own settings must reach its server
  // wherever it is placed, or mail-dependent sign-in silently stays off on a remote target.
  'HAPPIER_AUTH_EMAIL_',
];
// Secrets never enter a remote command line or its persisted env file.
const REMOTE_SERVER_LIGHT_NEVER_FORWARDED_ENV_KEYS = new Set(['HAPPIER_AUTH_EMAIL_SMTP_PASSWORD']);

function isRemoteServerLightSemanticEnvKey(key) {
  if (REMOTE_SERVER_LIGHT_NEVER_FORWARDED_ENV_KEYS.has(key)) return false;
  return REMOTE_SERVER_LIGHT_SEMANTIC_ENV_KEYS.has(key)
    || REMOTE_SERVER_LIGHT_SEMANTIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function projectRemoteServerLightSemanticEnvironment(env) {
  const projected = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isRemoteServerLightSemanticEnvKey(key) || value == null) continue;
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new Error('[dev-targets] invalid remote server semantic environment key');
    }
    const normalized = String(value).trim();
    if (!normalized) continue;
    if (/[\0\r\n]/.test(normalized)) {
      throw new Error('[dev-targets] invalid remote server semantic environment value');
    }
    projected[key] = normalized;
  }
  return projected;
}

export function resolveRemoteServerRuntimeConfig({ serverComponentName, env = {} } = {}) {
  if (serverComponentName !== 'happier-server-light') {
    throw new Error('[dev-targets] remote server placement only supports happier-server-light');
  }
  const effectiveProvider = resolveEffectiveDbProvider({ serverComponentName, env });
  if (!effectiveProvider.ok) {
    throw new Error('[dev-targets] remote server placement has an unsupported database provider configuration');
  }
  if (!['sqlite', 'postgres'].includes(effectiveProvider.provider)) {
    throw new Error('[dev-targets] remote server placement only supports SQLite or Postgres');
  }
  return {
    serverComponentName: 'happier-server-light',
    // The URL/credentials remain in the server host's env, never this projection.
    dbProvider: effectiveProvider.provider,
    environment: projectRemoteServerLightSemanticEnvironment({
      ...env,
      HAPPIER_SOCKET_ADAPTER_SCOPE: resolveStackSocketAdapterScope(env),
    }),
  };
}
