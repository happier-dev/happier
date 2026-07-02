import { join } from 'node:path';
import {
  renderPrismaCompatibleSqliteDatabaseUrl,
  resolvePrismaSqliteDatabaseUrlOptionsFromEnv,
} from '@happier-dev/cli-common/firstPartyRuntime';

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

export function applyRuntimeServerLightSqliteEnv({ env, serverDir }) {
  const dataDir = firstNonEmpty(env.HAPPIER_SERVER_LIGHT_DATA_DIR, env.HAPPY_SERVER_LIGHT_DATA_DIR);
  if (!dataDir) return;

  const databaseUrl = firstNonEmpty(
    env.DATABASE_URL,
    renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: join(dataDir, 'happier-server-light.sqlite'),
      platform: process.platform,
      sqlite: resolvePrismaSqliteDatabaseUrlOptionsFromEnv(env),
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
