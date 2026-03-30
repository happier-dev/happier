import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

async function ensureReleaseRuntimeBuilt(repoRoot) {
  const distPath = resolve(repoRoot, 'packages', 'release-runtime', 'dist', 'index.js');
  if (existsSync(distPath)) return;

  execFileSync('yarn', ['-s', 'workspace', '@happier-dev/release-runtime', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const relayDir = opts.relayDir ?? resolve(repoRoot, 'packages', 'relay-server');
  const lockPath = opts.lockPath ?? resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

  return withWorkspaceBundleLock(async () => {
    await ensureReleaseRuntimeBuilt(repoRoot);
    const {
      bundleWorkspacePackages,
      resolveWorkspaceBundlesFromPackageJson,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(repoRoot);

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: relayDir,
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
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
