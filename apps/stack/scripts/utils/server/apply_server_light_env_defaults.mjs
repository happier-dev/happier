import { join } from 'node:path';

function resolveLightDbProvider(env) {
  const raw = (env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? '').toString().trim().toLowerCase();
  return raw === 'pglite' ? 'pglite' : 'sqlite';
}

export function applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir }) {
  const dbProvider = resolveLightDbProvider(baseEnv);
  serverEnv.HAPPIER_DB_PROVIDER = dbProvider;
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
