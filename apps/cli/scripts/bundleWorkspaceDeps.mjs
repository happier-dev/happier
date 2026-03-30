import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO_ROOT = findRepoRoot(__dirname);

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

async function loadCliCommonWorkspacesModule(repoRoot) {
  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  if (!existsSync(modulePath)) {
    execFileSync('yarn', ['-s', 'workspace', '@happier-dev/cli-common', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await import(pathToFileURL(modulePath).href);
}

export async function bundleWorkspaceDeps(opts = {}) {
  // `repoRoot`/`happyCliDir` refer to the target repository we are bundling into.
  // In tests, this is a sandbox directory. The implementation helpers (cli-common workspaces)
  // must still be loaded from the *script* repo (this monorepo checkout), not from the sandbox.
  const targetRepoRoot = opts.repoRoot ?? SCRIPT_REPO_ROOT;
  const happyCliDir = opts.happyCliDir ?? resolve(targetRepoRoot, 'apps', 'cli');
  const lockPath = opts.lockPath ?? resolve(targetRepoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

  return withWorkspaceBundleLock(async () => {
    const {
      bundleWorkspacePackages,
      resolveWorkspaceBundlesFromPackageJson,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(SCRIPT_REPO_ROOT);

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot: targetRepoRoot,
      hostPackageDir: happyCliDir,
    });
    bundleWorkspacePackages({ bundles });

    for (const b of bundles) {
      vendorBundledPackageRuntimeDependencies({
        srcPackageJsonPath: resolve(b.srcDir, 'package.json'),
        destPackageDir: b.destDir,
      });
    }
  }, { lockPath, timeoutMs: 240_000, pollIntervalMs: 250, staleAfterMs: 240_000 });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    await bundleWorkspaceDeps();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
