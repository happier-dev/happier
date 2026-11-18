import { registerStandardCleanupTarget } from '../cleanup/standardCleanup';
import type { BundledPluginPackagedResource, BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from '@/sync/domains/plugins/availability/bundledPluginUiArtifactInventory';

// Package/Expo asset boundary only: this test app contains no preseeded bundle
// bytes. Artifact selection, source adapters, leases, and catalogs remain real.
const bundledArtifacts: BundledPluginUiAppArtifactInventory[number][] = [];
export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS: BundledPluginUiAppArtifactInventory = bundledArtifacts;
export let BUNDLED_PLUGIN_UI_APP_DECLARATIONS: readonly PluginHostBundledUiDeclaration[] = Object.freeze([]);

/** App package boundary: tests install producer-built declaration facts and restore their prior inventory. */
export function installBundledPluginUiDeclarationsForTests(declarations: readonly PluginHostBundledUiDeclaration[]): () => void {
    const previous = BUNDLED_PLUGIN_UI_APP_DECLARATIONS;
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS = Object.freeze([...declarations]);
    return () => { BUNDLED_PLUGIN_UI_APP_DECLARATIONS = previous; };
}

// Several UI clients in one test share the app package, including after one
// client disconnects. Restore that physical inventory only at test teardown.
let restoreTestDeclarations: (() => void) | undefined;
export function installBundledPluginUiDeclarationsForTest(declarations: readonly PluginHostBundledUiDeclaration[]): void {
    const restore = installBundledPluginUiDeclarationsForTests([
        ...BUNDLED_PLUGIN_UI_APP_DECLARATIONS.filter(current => !declarations.some(next => next.pluginId === current.pluginId)),
        ...declarations,
    ]);
    if (!restoreTestDeclarations) {
        restoreTestDeclarations = restore;
        registerStandardCleanupTarget({ unmount() {
            restoreTestDeclarations?.();
            restoreTestDeclarations = undefined;
        } });
    }
}

/** App package boundary for producer-compiled executable bytes in composed journeys. */
export function installBundledPluginUiArtifactsForTests(artifacts: BundledPluginUiAppArtifactInventory): () => void {
    const previous = [...bundledArtifacts];
    // App sources retain the build inventory at module load, before a journey
    // installs its compiled bytes. Preserve that physical package identity.
    bundledArtifacts.splice(0, bundledArtifacts.length, ...artifacts);
    return () => { bundledArtifacts.splice(0, bundledArtifacts.length, ...previous); };
}
export const BUNDLED_PLUGIN_BRAND_MARKS = Object.freeze([]);
export const BUNDLED_PLUGIN_PACKAGED_RESOURCES = Object.freeze([]) satisfies readonly BundledPluginPackagedResource[];

export const emptyBundledPluginUiAssetsModule = Object.freeze({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS,
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS,
    BUNDLED_PLUGIN_BRAND_MARKS,
    BUNDLED_PLUGIN_PACKAGED_RESOURCES,
});
