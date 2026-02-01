import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expandHome } from './canonical_home.mjs';

function resolveInvokerPackageName(cliRootDir) {
  try {
    const raw = readFileSync(join(cliRootDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    const name = String(pkg?.name ?? '').trim();
    return name || null;
  } catch {
    return null;
  }
}

export function getRuntimeDir() {
  const fromEnv = (process.env.HAPPIER_STACK_RUNTIME_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  const homeDir = (process.env.HAPPIER_STACK_HOME_DIR ?? '').trim()
    ? expandHome(process.env.HAPPIER_STACK_HOME_DIR.trim())
    : join(homedir(), '.happier-stack');
  return join(homeDir, 'runtime');
}

export function resolveInstalledCliRoot(cliRootDir) {
  const runtimeDir = getRuntimeDir();
  const pkgName = resolveInvokerPackageName(cliRootDir);
  const runtimePkgRoot = pkgName ? join(runtimeDir, 'node_modules', ...pkgName.split('/')) : null;
  if (runtimePkgRoot && existsSync(runtimePkgRoot)) {
    return runtimePkgRoot;
  }
  return cliRootDir;
}

export function resolveInstalledPath(cliRootDir, relativePath) {
  return join(resolveInstalledCliRoot(cliRootDir), relativePath);
}
