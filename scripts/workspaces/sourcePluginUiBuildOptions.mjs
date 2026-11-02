import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource,
  SOURCE_CONDITION } from '../../packages/cli-common/sourceRuntimeEntries.mjs';

export const SOURCE_PLUGIN_UI_IMPORT_CONDITIONS = Object.freeze(['react-native', 'browser']);

/** Inventory and staged package builds share the authored workspace resolver;
 * Node's source loader alone does not control the bundler's dependency graph. */
export async function sourcePluginUiBuildOptions({ repoRoot, packages, resolveSourceImport,
  sourceImportConditions: conditions = SOURCE_PLUGIN_UI_IMPORT_CONDITIONS }) {
  if (!resolveSourceImport) {
    packages ??= await readWorkspacePackages(repoRoot);
    resolveSourceImport = specifier => specifier.startsWith('@happier-dev/') || packages.has(packageNameOfSpecifier(specifier))
      ? resolveWorkspaceSource(packages, specifier, { conditions }) : undefined;
  }
  return { exportConditions: [SOURCE_CONDITION], resolveSourceImport };
}
