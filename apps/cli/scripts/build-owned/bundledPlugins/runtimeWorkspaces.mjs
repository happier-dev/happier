import { PLUGIN_PACKAGE_PREFIX } from '../bundledPluginMembership.ts';

/**
 * Plugin-to-plugin imports stay source-owned; only host workspaces supply dist.
 * @param {readonly Readonly<{packageName: string, srcDir: string}>[]} bundles
 * @returns {Readonly<Record<string, string>>}
 */
export function selectCanonicalRuntimeWorkspacePackageRoots(bundles) {
  /** @type {Record<string, string>} */
  const roots = {};
  for (const bundle of bundles) {
    if (bundle.packageName.startsWith(PLUGIN_PACKAGE_PREFIX)) continue;
    if (Object.hasOwn(roots, bundle.packageName)) {
      throw new Error(`Duplicate canonical workspace package root for '${bundle.packageName}'`);
    }
    roots[bundle.packageName] = bundle.srcDir;
  }
  return Object.freeze(roots);
}

/**
 * @param {string} repoRoot
 * @param {readonly Readonly<{packageName: string, srcDir: string}>[]} bundles
 * @param {Parameters<typeof import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs').ensureWorkspacePackagesBuiltByName>[2]} [buildOptions]
 */
export async function prepareCanonicalRuntimeWorkspacePackages(repoRoot, bundles, buildOptions = {}) {
  const roots = selectCanonicalRuntimeWorkspacePackageRoots(bundles);
  const { ensureWorkspacePackagesBuiltByName } = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  // The canonical publisher alone decides freshness, including changed and
  // deleted source exports. Artifact aliases can then consume its dist output.
  await ensureWorkspacePackagesBuiltByName(repoRoot, Object.keys(roots), {
    ...buildOptions,
    includeDevDependencies: false,
    publicationMode: 'artifact',
  });
  return roots;
}
