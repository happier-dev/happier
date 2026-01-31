import { join } from 'node:path';

import { expandHome } from '../paths/canonical_home.mjs';
import { getDefaultAutostartPaths } from '../paths/paths.mjs';

export function getCliHomeDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env?.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'cli');
}

export function getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env?.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'server-light');
}

export function resolveCliHomeDir(env = process.env) {
  const fromExplicit = (env.HAPPY_HOME_DIR ?? '').trim();
  if (fromExplicit) {
    return expandHome(fromExplicit);
  }
  const fromStacks = (env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim();
  if (fromStacks) {
    return expandHome(fromStacks);
  }
  return join(getDefaultAutostartPaths().baseDir, 'cli');
}
