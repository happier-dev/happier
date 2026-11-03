import type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from '@/sync/domains/plugins/availability/bundledPluginUiArtifactInventory';

// Package/Expo asset boundary only: this test app contains no preseeded bundle
// bytes. Artifact selection, source adapters, leases, and catalogs remain real.
export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = Object.freeze([]) satisfies BundledPluginUiAppArtifactInventory;
export let BUNDLED_PLUGIN_UI_APP_DECLARATIONS: readonly PluginHostBundledUiDeclaration[] = Object.freeze([]);

/** App package boundary: tests install producer-built declaration facts and restore their prior inventory. */
export function installBundledPluginUiDeclarationsForTests(declarations: readonly PluginHostBundledUiDeclaration[]): () => void {
    const previous = BUNDLED_PLUGIN_UI_APP_DECLARATIONS;
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS = Object.freeze([...declarations]);
    return () => { BUNDLED_PLUGIN_UI_APP_DECLARATIONS = previous; };
}
export const BUNDLED_PLUGIN_BRAND_MARKS = Object.freeze([]);

export const emptyBundledPluginUiAssetsModule = Object.freeze({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS,
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS,
    BUNDLED_PLUGIN_BRAND_MARKS,
});
