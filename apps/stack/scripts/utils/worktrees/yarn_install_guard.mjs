import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function mtimeMs(p) {
  try {
    const s = await stat(p);
    return s.mtimeMs ?? 0;
  } catch {
    return 0;
  }
}

async function maxPatchMtimeMs(componentDir) {
  const patchesDir = join(componentDir, 'patches');
  const base = await mtimeMs(patchesDir);
  if (!base) return 0;
  try {
    const entries = await readdir(patchesDir, { withFileTypes: true });
    let max = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.patch')) continue;
      const m = await mtimeMs(join(patchesDir, e.name));
      if (m > max) max = m;
    }
    return max;
  } catch {
    return 0;
  }
}

/**
 * Decide whether a Yarn install needs to run, based on the same timestamp heuristic
 * used by stack bootstrap:
 * - if node_modules missing => install
 * - if yarn.lock/package.json/patches newer than .yarn-integrity => install
 */
export async function shouldRunYarnInstall({ installDir, componentDir }) {
  const nodeModules = join(installDir, 'node_modules');
  const nodeModulesM = await mtimeMs(nodeModules);
  if (!nodeModulesM) return true;

  const yarnIntegrity = join(nodeModules, '.yarn-integrity');
  const intM = await mtimeMs(yarnIntegrity);
  if (!intM) return true;

  const yarnLock = join(installDir, 'yarn.lock');
  const lockM = await mtimeMs(yarnLock);
  const pkgM = await mtimeMs(join(installDir, 'package.json'));
  const patchM = await maxPatchMtimeMs(componentDir);

  return lockM > intM || pkgM > intM || patchM > intM;
}
