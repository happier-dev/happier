import { join } from 'node:path';
import { applyEffectiveDbProviderEnv } from './effective_db_provider.mjs';

export function applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir }) {
  const dbProvider = applyEffectiveDbProviderEnv({
    serverComponentName: 'happier-server-light',
    env: baseEnv,
    targetEnv: serverEnv,
  });
  delete serverEnv.DATABASE_URL;
  const dataDir = baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR?.trim()
    ? baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR.trim()
    : join(baseDir, 'server-light');
  serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
  serverEnv.HAPPIER_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR?.trim()
    ? baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR.trim()
    : join(dataDir, 'files');
  if (dbProvider === 'pglite') {
    serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR = baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR?.trim()
      ? baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR.trim()
      : join(dataDir, 'pglite');
  } else {
    delete serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR;
  }
}
