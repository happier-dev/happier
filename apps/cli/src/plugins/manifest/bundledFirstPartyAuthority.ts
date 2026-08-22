import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolveWorkspaceBundlesFromPackageJson } from '@happier-dev/cli-common/workspaces';

/**
 * A first-party bundled plugin package deliberately stays private and omits the
 * external-plugin discovery metadata an installable artifact must declare. This
 * is the single predicate for that package contract; the packaging owner, the
 * archive staging validator, and local source resolution all read it here.
 */
export function declaresBundledFirstPartyWorkspacePackageContract(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const packageJson = value as Readonly<Record<string, unknown>>;
  return packageJson.private === true
    && packageJson.keywords === undefined
    && packageJson.happier === undefined;
}

function findBundledWorkspaceRepoRoot(packageRootPath: string): string | null {
  let candidate = resolve(packageRootPath);
  while (true) {
    if (
      existsSync(join(candidate, 'yarn.lock'))
      && existsSync(join(candidate, 'apps', 'cli', 'package.json'))
      && existsSync(join(candidate, 'packages'))
    ) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

/**
 * Canonical membership check: the path is the exact source root the current
 * checkout's CLI bundles under `packageName`. A packaged install has no
 * workspace above it, so this resolves to `false` there and the caller keeps
 * external authority. Any inconsistency in the workspace inventory also fails
 * closed rather than granting first-party authority.
 */
export async function isCanonicalBundledFirstPartyWorkspacePluginPackage(params: Readonly<{
  packageRootPath: string;
  packageName: string;
}>): Promise<boolean> {
  const repoRoot = findBundledWorkspaceRepoRoot(params.packageRootPath);
  if (!repoRoot) return false;
  let bundleSourceDir: string | undefined;
  try {
    bundleSourceDir = resolveWorkspaceBundlesFromPackageJson({
      repoRoot,
      hostPackageDir: join(repoRoot, 'apps', 'cli'),
    }).find((candidate) => candidate.packageName === params.packageName)?.srcDir;
  } catch {
    return false;
  }
  if (!bundleSourceDir) return false;
  try {
    const [canonicalSourceRoot, packageRoot] = await Promise.all([
      realpath(bundleSourceDir),
      realpath(params.packageRootPath),
    ]);
    return canonicalSourceRoot === packageRoot;
  } catch {
    return false;
  }
}

/**
 * Derives the manifest authority a local plugin source root actually carries.
 *
 * The reserved `happier.*` namespace exists to stop a distributed third-party
 * artifact from impersonating a first-party plugin — not to stop a maintainer
 * from developing the plugins this repository ships. A root that IS the current
 * checkout's canonical bundled source therefore validates under the same
 * first-party authority the bundled loader grants it; everything else stays
 * external.
 */
export async function resolveLocalPluginSourceManifestAuthority(params: Readonly<{
  pluginRootPath: string;
}>): Promise<'external' | 'bundled_first_party'> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(join(params.pluginRootPath, 'package.json'), 'utf8')) as unknown;
  } catch {
    return 'external';
  }
  if (!declaresBundledFirstPartyWorkspacePackageContract(packageJson)) return 'external';
  const packageName = (packageJson as Readonly<Record<string, unknown>>).name;
  if (typeof packageName !== 'string' || !packageName.trim()) return 'external';
  return await isCanonicalBundledFirstPartyWorkspacePluginPackage({
    packageRootPath: params.pluginRootPath,
    packageName,
  })
    ? 'bundled_first_party'
    : 'external';
}
