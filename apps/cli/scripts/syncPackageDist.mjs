import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolveCliPackageRoot(scriptDir = __dirname) {
  return resolve(scriptDir, '..');
}

export function syncPackageDist(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const distDir = resolve(String(options.distDir ?? resolve(packageRoot, 'dist')));
  const packageDistDir = resolve(String(options.packageDistDir ?? resolve(packageRoot, 'package-dist')));
  const exists = options.existsSync ?? existsSync;
  const copy = options.cpSync ?? cpSync;
  const remove = options.rmSync ?? rmSync;

  if (!exists(distDir)) {
    throw new Error(`[sync-package-dist] missing dist directory: ${distDir}`);
  }

  remove(packageDistDir, { recursive: true, force: true });
  copy(distDir, packageDistDir, { recursive: true });

  return {
    packageRoot,
    distDir,
    packageDistDir,
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    syncPackageDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
