import { join } from 'node:path';

import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';

export function resolveConfiguredCodexHome(env: NodeJS.ProcessEnv): string {
  const override = expandHomeDirPath(typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '', env);
  if (override.length > 0) {
    return override;
  }
  return join(resolveHomeDirFromEnvironment(env), '.codex');
}

export function resolveConfiguredCodexConfigTomlPath(env: NodeJS.ProcessEnv): string {
  return join(resolveConfiguredCodexHome(env), 'config.toml');
}
