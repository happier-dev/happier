export const BUNDLED_PLUGIN_MANIFEST_RELATIVE_PATH: '.happier-plugin/plugin.json';

/**
 * Packaged resource paths a bundled plugin package's own manifest declares.
 * Declarations that escape the package root are excluded.
 */
export function readBundledPluginPackageResourceRelativePaths(
  packageRoot: string,
): readonly string[];

/**
 * Packaged resources the manifest declares that this package tree cannot serve.
 * Empty means the tree matches its own manifest.
 */
export function findUnservableBundledPluginPackageResources(
  packageRoot: string,
): readonly string[];
