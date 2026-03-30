import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function resolveCliCommonDistModulePath(repoRoot, subpath) {
  return resolve(repoRoot, 'packages', 'cli-common', 'dist', subpath, 'index.js');
}

function resolveCliCommonBuildScriptPath(repoRoot) {
  return resolve(repoRoot, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs');
}

function runCliCommonBuild(repoRoot, exec = execFileSync) {
  exec(process.execPath, [resolveCliCommonBuildScriptPath(repoRoot)], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

/**
 * Loads a built `@happier-dev/cli-common` dist submodule, rebuilding it on demand when missing.
 * @param {{ repoRoot: string; subpath: string; existsSync?: (path: string) => boolean; execFileSync?: typeof execFileSync; importModule?: (url: string) => Promise<any>; }} options
 */
export async function loadCliCommonDistModule(options) {
  const repoRoot = String(options.repoRoot ?? '').trim();
  const subpath = String(options.subpath ?? '').trim();
  if (!repoRoot) throw new Error('[release] loadCliCommonDistModule requires repoRoot');
  if (!subpath) throw new Error('[release] loadCliCommonDistModule requires subpath');

  const exists = options.existsSync ?? existsSync;
  const exec = options.execFileSync ?? execFileSync;
  const importModule = options.importModule ?? ((url) => import(url));
  const modulePath = resolveCliCommonDistModulePath(repoRoot, subpath);

  const importOnce = async () => importModule(pathToFileURL(modulePath).href);

  if (!exists(modulePath)) {
    runCliCommonBuild(repoRoot, exec);
  }

  try {
    return await importOnce();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code ?? '') : '';
    const message = String(error?.message ?? error ?? '');
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(message)) {
      if (!exists(modulePath)) {
        runCliCommonBuild(repoRoot, exec);
        return await importOnce();
      }
    }
    throw error;
  }
}

export function resolveCliCommonDistModulePathForTests(repoRoot, subpath) {
  return resolveCliCommonDistModulePath(repoRoot, subpath);
}

