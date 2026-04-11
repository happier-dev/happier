import { join } from 'node:path';

import { expandHome } from '../paths/canonical_home.mjs';
import { getDefaultAutostartPaths } from '../paths/paths.mjs';

export function getCliHomeDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = expandHome((env?.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim(), env);
  return fromEnv || join(stackBaseDir, 'cli');
}

export function getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = expandHome((env?.HAPPIER_SERVER_LIGHT_DATA_DIR ?? '').trim(), env);
  return fromEnv || join(stackBaseDir, 'server-light');
}

export function resolveCliHomeDir(env = process.env, options = {}) {
  const preferStackCliHomeDir = options.preferStackCliHomeDir === true;
  const fromStacks = (env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim();
  if (preferStackCliHomeDir && fromStacks) {
    return expandHome(fromStacks, env);
  }
  const fromExplicit = (env.HAPPIER_HOME_DIR ?? '').trim();
  if (fromExplicit) {
    return expandHome(fromExplicit, env);
  }
  if (fromStacks) {
    return expandHome(fromStacks, env);
  }
  return join(getDefaultAutostartPaths().baseDir, 'cli');
}
