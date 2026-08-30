import { join } from 'node:path';
import { expandHome } from '../paths/canonical_home.mjs';
import { applyEffectiveDbProviderEnv, resolveDbProviderDatabaseUrl } from './effective_db_provider.mjs';

export function applyServerPresetEnvDefaults({ serverComponentName, baseEnv, serverEnv, baseDir }) {
  const dbProvider = applyEffectiveDbProviderEnv({
    serverComponentName,
    env: baseEnv,
    targetEnv: serverEnv,
  });
  const databaseAuthority = resolveDbProviderDatabaseUrl({
    provider: dbProvider,
    databaseUrl: serverEnv.DATABASE_URL,
  });
  if (databaseAuthority.removeDatabaseUrl) delete serverEnv.DATABASE_URL;
  const lightPreset = serverComponentName === 'happier-server-light';
  if (!lightPreset && dbProvider !== 'sqlite' && dbProvider !== 'pglite') return;
  const dataDir = baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR?.trim()
    ? expandHome(baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR.trim(), baseEnv)
    : join(baseDir, 'server-light');
  serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
  if (lightPreset) {
    serverEnv.HAPPIER_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR?.trim()
      ? expandHome(baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR.trim(), baseEnv)
      : join(dataDir, 'files');
  }
  if (dbProvider === 'pglite' || lightPreset) {
    serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR = baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR?.trim()
      ? expandHome(baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR.trim(), baseEnv)
      : join(dataDir, 'pglite');
  }
}
