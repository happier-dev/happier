import { dirname, join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { parseEnvToObject } from '../env/dotenv.mjs';
import { getServerLightDataDirFromEnvOrDefault } from '../stack/dirs.mjs';
import { resolvePersonalHomeRuntimeLayout } from '@happier-dev/cli-common/firstPartyRuntime/personalHome/layout';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { applyEffectiveDbProviderEnv, resolveEffectiveDbProviderTransition, resolveSharedDatabaseSource } from './effective_db_provider.mjs';
import {
  renderPrismaCompatibleSqliteDatabaseUrl,
  resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
} from '@happier-dev/cli-common/firstPartyRuntime/selfHostServerEnv';

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

const sharedS3EnvKeys = ['S3_HOST', 'S3_PORT', 'S3_USE_SSL', 'S3_BUCKET', 'S3_PRIVATE_BUCKET',
  'S3_PUBLIC_URL', 'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];

export function resolveServerFilesBackend({ env = {}, serverComponentName = env.HAPPIER_STACK_SERVER_COMPONENT } = {}) {
  return readServerConfig(env, SERVER_CONFIG.HAPPIER_FILES_BACKEND)
    ?? (serverComponentName === 'happier-server' ? 's3' : 'local');
}

export function applySharedDatabaseSourceEnv({ env }) {
  if (String(env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ?? '').trim()) {
    // Read the existing authority privately provisioned on the selected server
    // host. Secret values never enter command arguments or diagnostics.
    const sourceEnvPath = String(env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE ?? '').trim();
    if (!sourceEnvPath) throw new Error('[shared-db] source stack env reference is missing');
    let source;
    try { source = parseEnvToObject(readFileSync(sourceEnvPath, 'utf8')); }
    catch { throw new Error('[shared-db] source stack env is unavailable on this server host'); }
    const { provider, databaseUrl: explicitUrl } = resolveSharedDatabaseSource({ env: source });
    const filesBackend = resolveServerFilesBackend({ env: source });
    const socketAdapter = readServerConfig(source, SERVER_CONFIG.HAPPIER_SOCKET_ADAPTER);
    const redisUrl = readServerConfig(source, SERVER_CONFIG.REDIS_URL);
    const sourceDataDir = getServerLightDataDirFromEnvOrDefault({ stackBaseDir: dirname(sourceEnvPath), env: source });
    let secret = String(source.HANDY_MASTER_SECRET ?? '').trim();
    if (!secret) {
      try { secret = readFileSync(join(sourceDataDir, 'handy-master-secret.txt'), 'utf8').trim(); }
      catch { throw new Error('[shared-db] existing source server at-rest secret is unavailable'); }
    }
    if (!secret) throw new Error('[shared-db] existing source server at-rest secret is empty');
    const databaseUrl = firstNonEmpty(explicitUrl, renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: join(sourceDataDir, 'happier-server-light.sqlite'), platform: process.platform,
      sqlite: resolveServerLightSqliteDatabaseUrlOptionsFromEnv(source),
    }));
    // Personal Home's layout owns file paths and deliberately requires SQLite.
    // For Postgres use only its file projection, with no database URL supplied.
    const layout = resolvePersonalHomeRuntimeLayout({ env: { ...source,
      HAPPIER_SERVER_LIGHT_DATA_DIR: sourceDataDir, DATABASE_URL: provider === 'sqlite' ? databaseUrl : '' } });
    if (provider === 'sqlite') {
      try {
        if (!statSync(layout.databasePath).isFile()) throw new Error('not a file');
      } catch { throw new Error('[shared-db] existing source database is unavailable on this server host'); }
    }
    env.HAPPIER_DB_PROVIDER = provider;
    env.DATABASE_URL = databaseUrl;
    env.HANDY_MASTER_SECRET = secret;
    env.HAPPIER_FILES_BACKEND = filesBackend;
    env.HAPPY_FILES_BACKEND = filesBackend;
    // Servers sharing the database also consume its source's socket cluster.
    // Clear stale consumer settings when that source no longer enables Redis.
    delete env.HAPPIER_SOCKET_ADAPTER;
    delete env.REDIS_URL;
    if (socketAdapter === 'redis-streams' && redisUrl) {
      env.HAPPIER_SOCKET_ADAPTER = socketAdapter;
      env.REDIS_URL = redisUrl;
    }
    // The source stack owns storage selection as well as the database. S3
    // removes host-local blob roots; local storage remains valid for SQLite
    // stacks on their data host. Clear the prior projection on either transition.
    for (const key of sharedS3EnvKeys) {
      delete env[key];
      if (filesBackend === 's3' && source[key] != null) env[key] = source[key];
    }
    if (filesBackend === 's3') {
      delete env.HAPPIER_SERVER_LIGHT_FILES_DIR;
      delete env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR;
      delete env.HAPPY_SERVER_LIGHT_FILES_DIR;
      delete env.HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR;
    } else {
      env.HAPPIER_SERVER_LIGHT_FILES_DIR = layout.publicFilesDir;
      env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR = layout.privateFilesDir;
    }
    env.HAPPIER_SQLITE_AUTO_MIGRATE = '0';
    env.HAPPY_SQLITE_AUTO_MIGRATE = '0';
    env.HAPPIER_STACK_MIGRATE_MODE = 'skip';
    // Runtime launch admission uses the canonical self-host migration controls.
    // A shared-database consumer must never migrate its source's retained data.
    env.RUN_MIGRATIONS = '0';
    env.HAPPIER_STACK_PRISMA_MIGRATE = '0';
    env.METRICS_ENABLED = 'false';
  }
}

/** Resolve a server bundle's provider on the server host, after projecting any
 * host-owned shared-database source into the runtime environment. */
export function applyServerHostDatabaseProviderEnv({ serverComponentName, env }) {
  applySharedDatabaseSourceEnv({ env });
  return applyEffectiveDbProviderEnv({ serverComponentName, env });
}

export function applyRuntimeServerDatabaseEnv({ env, serverDir }) {
  const provider = applyServerHostDatabaseProviderEnv({ serverComponentName: 'happier-server-light', env });
  if (provider === 'postgres') {
    const transition = resolveEffectiveDbProviderTransition({ nextServerComponentName: 'happier-server-light', env });
    if (!transition.ok) throw new Error('[local] postgres requires a compatible explicit DATABASE_URL');
    return;
  }
  if (provider !== 'sqlite') return;
  const dataDir = firstNonEmpty(env.HAPPIER_SERVER_LIGHT_DATA_DIR, env.HAPPY_SERVER_LIGHT_DATA_DIR);
  if (!dataDir) return;

  const databaseUrl = firstNonEmpty(
    env.DATABASE_URL,
    renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: join(dataDir, 'happier-server-light.sqlite'),
      platform: process.platform,
      sqlite: resolveServerLightSqliteDatabaseUrlOptionsFromEnv(env),
    }),
  );
  const migrationsDir = join(serverDir, 'prisma', 'sqlite', 'migrations');

  env.DATABASE_URL = databaseUrl;
  env.HAPPIER_SQLITE_AUTO_MIGRATE = firstNonEmpty(env.HAPPIER_SQLITE_AUTO_MIGRATE, env.HAPPY_SQLITE_AUTO_MIGRATE, '1');
  env.HAPPIER_SQLITE_MIGRATIONS_DIR = firstNonEmpty(
    env.HAPPIER_SQLITE_MIGRATIONS_DIR,
    env.HAPPY_SQLITE_MIGRATIONS_DIR,
    migrationsDir,
  );
}
