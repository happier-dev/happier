import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCliCommonWorkspacesModule } from './workspaces/loadCliCommonWorkspacesModule.mjs';

function resolveCliCommonDistModulePath(repoRoot, subpath) {
  return resolve(repoRoot, 'packages', 'cli-common', 'dist', subpath, 'index.js');
}

function resolveCliCommonBuildScriptPath(repoRoot) {
  return resolve(repoRoot, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs');
}

function runCliCommonBuild(repoRoot, exec = execFileSync) {
  exec(process.execPath, [resolveCliCommonBuildScriptPath(repoRoot), '--declarations'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

/**
 * Loads a built `@happier-dev/cli-common` dist submodule after canonical stale-only admission.
 * Artifact callers can request forced admission through the canonical workspace loader.
 * @param {{ repoRoot: string; subpath: string; force?: boolean; env?: NodeJS.ProcessEnv; execFileSync?: typeof execFileSync; importModule?: (url: string) => Promise<any>; loadCliCommonWorkspacesModuleImpl?: typeof loadCliCommonWorkspacesModule; }} options
 */
export async function loadCliCommonDistModule(options) {
  const repoRoot = String(options.repoRoot ?? '').trim();
  const subpath = String(options.subpath ?? '').trim();
  if (!repoRoot) throw new Error('[release] loadCliCommonDistModule requires repoRoot');
  if (!subpath) throw new Error('[release] loadCliCommonDistModule requires subpath');

  const exec = options.execFileSync ?? execFileSync;
  const importModule = options.importModule ?? ((url) => import(url));
  const modulePath = resolveCliCommonDistModulePath(repoRoot, subpath);

  const importOnce = async () => importModule(pathToFileURL(modulePath).href);

  if (options.force === true) {
    const loadWorkspaces =
      options.loadCliCommonWorkspacesModuleImpl ?? loadCliCommonWorkspacesModule;
    await loadWorkspaces(
      repoRoot,
      options.env ?? process.env,
      undefined,
      {
        force: true,
        includeDevDependencies: false,
        quiet: true,
      },
    );
  } else {
    runCliCommonBuild(repoRoot, exec);
  }
  return await importOnce();
}

export function resolveCliCommonDistModulePathForTests(repoRoot, subpath) {
  return resolveCliCommonDistModulePath(repoRoot, subpath);
}
