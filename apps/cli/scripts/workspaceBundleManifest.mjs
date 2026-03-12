import { resolve } from 'node:path';

export const bundledWorkspacePackages = ['agents', 'cli-common', 'protocol', 'release-runtime'];

export function createBundledWorkspaceBundles({ repoRoot, targetRoot }) {
  return bundledWorkspacePackages.map((pkg) => ({
    packageName: `@happier-dev/${pkg}`,
    srcDir: resolve(repoRoot, 'packages', pkg),
    destDir: resolve(targetRoot, 'node_modules', '@happier-dev', pkg),
  }));
}
