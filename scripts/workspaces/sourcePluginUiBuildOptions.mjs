import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource,
  SOURCE_CONDITION } from '../../packages/cli-common/sourceRuntimeEntries.mjs';

export const SOURCE_PLUGIN_UI_IMPORT_CONDITIONS = Object.freeze(['react-native', 'browser']);

/** Inventory and staged package builds share the authored workspace resolver;
 * Node's source loader alone does not control the bundler's dependency graph.
 * @param {{ repoRoot: string, packages?: Awaited<ReturnType<typeof readWorkspacePackages>>,
 *   resolveSourceImport?: (specifier: string) => string | undefined, sourceImportConditions?: readonly string[] }} options
 */
export async function sourcePluginUiBuildOptions({ repoRoot, packages, resolveSourceImport,
  sourceImportConditions: conditions = SOURCE_PLUGIN_UI_IMPORT_CONDITIONS }) {
  if (!resolveSourceImport) {
    const workspacePackages = packages ?? await readWorkspacePackages(repoRoot);
    resolveSourceImport = specifier => specifier.startsWith('@happier-dev/') || workspacePackages.has(packageNameOfSpecifier(specifier))
      ? resolveWorkspaceSource(workspacePackages, specifier, { conditions }) : undefined;
  }
  return { exportConditions: [SOURCE_CONDITION], resolveSourceImport };
}
