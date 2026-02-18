import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bundleWorkspacePackages,
  findRepoRoot,
  vendorBundledPackageRuntimeDependencies,
} from '../../../packages/cli-common/dist/workspaces/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function vendorBundledDependencyFromRootNodeModules(params) {
  const repoRoot = params.repoRoot;
  const happyCliDir = params.happyCliDir;
  const packageName = params.packageName;

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('vendorBundledDependencyFromRootNodeModules requires repoRoot');
  }
  if (typeof happyCliDir !== 'string' || happyCliDir.length === 0) {
    throw new Error('vendorBundledDependencyFromRootNodeModules requires happyCliDir');
  }
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error('vendorBundledDependencyFromRootNodeModules requires packageName');
  }

  const srcDir = resolve(repoRoot, 'node_modules', packageName);
  const destDir = resolve(happyCliDir, 'node_modules', packageName);

  if (!existsSync(srcDir)) {
    throw new Error(`Unable to vendor dependency '${packageName}': missing ${srcDir}`);
  }

  mkdirSync(resolve(happyCliDir, 'node_modules'), { recursive: true });
  rmSync(destDir, { recursive: true, force: true });
  cpSync(srcDir, destDir, { recursive: true });
}

export function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const happyCliDir = opts.happyCliDir ?? resolve(repoRoot, 'apps', 'cli');

  const bundles = [
    {
      packageName: '@happier-dev/agents',
      srcDir: resolve(repoRoot, 'packages', 'agents'),
      destDir: resolve(happyCliDir, 'node_modules', '@happier-dev', 'agents'),
    },
    {
      packageName: '@happier-dev/cli-common',
      srcDir: resolve(repoRoot, 'packages', 'cli-common'),
      destDir: resolve(happyCliDir, 'node_modules', '@happier-dev', 'cli-common'),
    },
    {
      packageName: '@happier-dev/protocol',
      srcDir: resolve(repoRoot, 'packages', 'protocol'),
      destDir: resolve(happyCliDir, 'node_modules', '@happier-dev', 'protocol'),
    },
  ];
  bundleWorkspacePackages({ bundles });

  for (const b of bundles) {
    vendorBundledPackageRuntimeDependencies({
      srcPackageJsonPath: resolve(b.srcDir, 'package.json'),
      destPackageDir: b.destDir,
    });
  }

  // `npm pack` only includes `bundledDependencies` if they're present under apps/cli/node_modules.
  // Yarn hoists to the repo root by default, so we explicitly vendor these from the root node_modules.
  vendorBundledDependencyFromRootNodeModules({ repoRoot, happyCliDir, packageName: 'base64-js' });
  vendorBundledDependencyFromRootNodeModules({ repoRoot, happyCliDir, packageName: '@noble/hashes' });
  vendorBundledDependencyFromRootNodeModules({ repoRoot, happyCliDir, packageName: 'tweetnacl' });
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    bundleWorkspaceDeps();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
