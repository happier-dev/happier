import { dirname, join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { parseEnvToObject } from '../env/dotenv.mjs';
import { getServerLightDataDirFromEnvOrDefault } from '../stack/dirs.mjs';
import { resolvePersonalHomeRuntimeLayout } from '@happier-dev/cli-common/firstPartyRuntime/server';
import { resolveEffectiveDbProvider, resolveEffectiveDbProviderTransition, resolveSharedDatabaseSource } from './effective_db_provider.mjs';
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

export function applySharedDatabaseSourceEnv({ env }) {
  if (String(env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ?? '').trim()) {
    // Read the existing authority on the server host. Never serialize its key
    // into the consumer env file, controller transport, or command arguments.
    const sourceEnvPath = String(env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE ?? '').trim();
    if (!sourceEnvPath) throw new Error('[shared-db] source stack env reference is missing');
    let source;
    try { source = parseEnvToObject(readFileSync(sourceEnvPath, 'utf8')); }
    catch { throw new Error('[shared-db] source stack env is unavailable on this server host'); }
    const { provider, databaseUrl: explicitUrl } = resolveSharedDatabaseSource({ env: source });
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
    env.HAPPIER_SERVER_LIGHT_FILES_DIR = layout.publicFilesDir;
    env.HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR = layout.privateFilesDir;
    env.HAPPIER_SQLITE_AUTO_MIGRATE = '0';
    env.HAPPY_SQLITE_AUTO_MIGRATE = '0';
    env.HAPPIER_STACK_MIGRATE_MODE = 'skip';
    env.METRICS_ENABLED = 'false';
  }
}

export function applyRuntimeServerDatabaseEnv({ env, serverDir }) {
  applySharedDatabaseSourceEnv({ env });
  const effective = resolveEffectiveDbProvider({ serverComponentName: 'happier-server-light', env });
  if (!effective.ok) throw new Error('[local] unsupported DB provider');
  if (effective.provider === 'postgres') {
    const transition = resolveEffectiveDbProviderTransition({ nextServerComponentName: 'happier-server-light', env });
    if (!transition.ok) throw new Error('[local] postgres requires a compatible explicit DATABASE_URL');
    return;
  }
  if (effective.provider !== 'sqlite') return;
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
