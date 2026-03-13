import { resolve } from 'node:path';

export const bundledWorkspacePackages = Object.freeze([
  { dirName: 'agents', packageName: '@happier-dev/agents' },
  { dirName: 'cli-common', packageName: '@happier-dev/cli-common' },
  { dirName: 'protocol', packageName: '@happier-dev/protocol' },
  { dirName: 'release-runtime', packageName: '@happier-dev/release-runtime' },
]);

export const bundledWorkspaceDirNames = Object.freeze(
  bundledWorkspacePackages.map(({ dirName }) => dirName),
);

export const bundledWorkspacePackageNames = Object.freeze(
  bundledWorkspacePackages.map(({ packageName }) => packageName),
);

export function createBundledWorkspaceBundles({ repoRoot, happyCliDir }) {
  return bundledWorkspacePackages.map(({ dirName, packageName }) => ({
    packageName,
    srcDir: resolve(repoRoot, 'packages', dirName),
    destDir: resolve(happyCliDir, 'node_modules', '@happier-dev', dirName),
  }));
}
