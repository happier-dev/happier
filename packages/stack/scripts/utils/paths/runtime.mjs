import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expandHome } from './canonical_home.mjs';

export function getRuntimeDir() {
  const fromEnv = (process.env.HAPPY_STACKS_RUNTIME_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  const homeDir = (process.env.HAPPY_STACKS_HOME_DIR ?? '').trim()
    ? expandHome(process.env.HAPPY_STACKS_HOME_DIR.trim())
    : join(homedir(), '.happy-stacks');
  return join(homeDir, 'runtime');
}

export function resolveInstalledCliRoot(cliRootDir) {
  const runtimeDir = getRuntimeDir();
  const runtimePkgRoot = join(runtimeDir, 'node_modules', 'happy-stacks');
  if (existsSync(runtimePkgRoot)) {
    return runtimePkgRoot;
  }
  return cliRootDir;
}

export function resolveInstalledPath(cliRootDir, relativePath) {
  return join(resolveInstalledCliRoot(cliRootDir), relativePath);
}

