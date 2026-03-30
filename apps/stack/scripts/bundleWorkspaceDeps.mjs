import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureWorkspacePackagesBuiltForComponent } from './utils/proc/pm.mjs';
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
  const cliCommonPackageJsonPath = resolve(repoRoot, 'packages', 'cli-common', 'package.json');
  if (existsSync(cliCommonPackageJsonPath)) {
    // Fail fast with a JSON parse error instead of surfacing Node's less-specific
    // "Invalid package config" error when importing ESM from a malformed package.json.
    JSON.parse(String(readFileSync(cliCommonPackageJsonPath, 'utf8')));
  }

  const modulePath = resolve(repoRoot, 'packages', 'cli-common', 'dist', 'workspaces', 'index.js');
  if (!existsSync(modulePath)) {
    const rootPackageJsonPath = resolve(repoRoot, 'package.json');
    const hasWorkspaces = (() => {
      if (!existsSync(rootPackageJsonPath)) return false;
      const parsed = JSON.parse(String(readFileSync(rootPackageJsonPath, 'utf8')));
      return Boolean(parsed && typeof parsed === 'object' && (parsed.workspaces || parsed.workspaces?.packages));
    })();

    if (hasWorkspaces) {
      const stackDir = resolve(repoRoot, 'apps', 'stack');
      await ensureWorkspacePackagesBuiltForComponent(stackDir, { quiet: true, env: process.env });
      if (!existsSync(modulePath)) {
        execFileSync('yarn', ['-s', 'workspace', '@happier-dev/cli-common', 'build'], {
          cwd: repoRoot,
          stdio: 'inherit',
        });
      }
    }
  }

  if (!existsSync(modulePath)) {
    throw new Error('Missing dist/ for @happier-dev/cli-common');
  }

  return await import(pathToFileURL(modulePath).href);
}

export async function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const stackDir = opts.stackDir ?? resolve(repoRoot, 'apps', 'stack');
  const lockPath = opts.lockPath ?? resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

  return withWorkspaceBundleLock(async () => {
    const {
      bundleWorkspacePackages,
      resolveWorkspaceBundlesFromPackageJson,
      vendorBundledPackageRuntimeDependencies,
    } = await loadCliCommonWorkspacesModule(repoRoot);

    const bundles = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: stackDir,
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
