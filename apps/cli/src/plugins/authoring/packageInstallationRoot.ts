import { basename, dirname } from 'node:path';

/**
 * Finds the `node_modules` tree that owns a package installed beside another
 * package in the same npm-style installation. Packaged CLI dependencies may
 * be nested under the CLI root or hoisted beside it; callers still validate
 * the exact dependency declaration and physical package bytes.
 */
export function resolveSameInstallNodeModulesRoot(packageRoot: string): string | null {
  const packageParent = dirname(packageRoot);
  if (basename(packageParent) === 'node_modules') {
    return packageParent;
  }
  const scopeParent = dirname(packageParent);
  return basename(packageParent).startsWith('@') && basename(scopeParent) === 'node_modules'
    ? scopeParent
    : null;
}
