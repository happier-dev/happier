import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STACK_HOST_APPS = ['stack'];

export function readBundledWorkspaceSyncConfig(cliRootDir, {
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
} = {}) {
  const cliRoot = String(cliRootDir ?? '').trim();
  if (!cliRoot) return null;

  const packageJsonPath = resolve(cliRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const packages = Array.isArray(packageJson?.bundledDependencies)
      ? packageJson.bundledDependencies
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.startsWith('@happier-dev/'))
        .map((value) => value.split('/').at(-1))
        .filter((value) => typeof value === 'string' && value.length > 0)
      : [];

    if (packages.length === 0) return null;

    return {
      hostApps: STACK_HOST_APPS,
      packages,
    };
  } catch {
    return null;
  }
}
