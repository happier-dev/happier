import { join } from 'node:path';

export function applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir }) {
  const dataDir = baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR?.trim()
    ? baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR.trim()
    : join(baseDir, 'server-light');
  serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
  serverEnv.HAPPIER_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR?.trim()
    ? baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR.trim()
    : join(dataDir, 'files');
  serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR = baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR?.trim()
    ? baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR.trim()
    : join(dataDir, 'pglite');
}
