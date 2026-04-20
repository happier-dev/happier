import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execYarn } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
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
    execYarn(['-s', 'workspace', '@happier-dev/cli-common', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  if (!existsSync(modulePath)) {
    throw new Error(`Missing cli-common workspaces build helpers: ${modulePath}`);
  }

  return await import(pathToFileURL(modulePath).href);
}

async function ensureWorkspaceBuilt(repoRoot, workspaceName) {
  const distPath = resolve(repoRoot, 'packages', workspaceName, 'dist', 'index.js');
  if (existsSync(distPath)) return;
  execYarn(['-s', 'workspace', `@happier-dev/${workspaceName}`, 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const supportDir = opts.supportDir ?? resolve(repoRoot, 'packages', 'support');
  const lockPath = opts.lockPath ?? resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

  return withWorkspaceBundleLock(async () => {
    await ensureWorkspaceBuilt(repoRoot, 'protocol');
    await ensureWorkspaceBuilt(repoRoot, 'release-runtime');
    await ensureWorkspaceBuilt(repoRoot, 'agents');

    const {
      bundleWorkspacePackages,
      resolveWorkspaceBundlesFromPackageJson,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(repoRoot);

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: supportDir,
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
