import { readGeneratedPluginUiArtifactsManifest } from '@/plugins/install/ui/generatedArtifacts';

// Mirrors the SDK build output layout
// (`PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH` = `dist/happier-plugin-ui`,
// manifest file `ui-artifacts.json`). Third-party plugins ship their built UI
// bundles here; the ids are NOT present in `manifest.contributes.uiArtifacts`
// (that field only carries first-party/pre-declared artifacts), so
// `plugins show` must read the built manifest to surface them.
/**
 * Read the contribution ids of the UI artifacts a plugin actually built into
 * its `dist/happier-plugin-ui/ui-artifacts.json`. Returns an empty list when
 * the plugin shipped no built UI bundle or the manifest is unreadable/invalid
 * — surfacing a partial build must never crash the catalog projection.
 */
export async function readBuiltUiArtifactContributionIds(
  pluginRootPath: string,
): Promise<readonly string[]> {
  const manifest = await readGeneratedPluginUiArtifactsManifest(pluginRootPath);
  if (!manifest) return [];
  const ids = manifest.entries.map((entry) => entry.contributionId);
  return Object.freeze([...new Set(ids)]);
}
