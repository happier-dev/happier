import type { BundledPluginBrandMark, BundledPluginPackagedResource, BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';

/** Runtime inventory is generated into the sibling .js file during app preparation. */
export declare const BUNDLED_PLUGIN_UI_APP_ARTIFACTS: BundledPluginUiAppArtifactInventory;
/** Semantic declarations projected by the CLI-owned declaration producer. */
export declare const BUNDLED_PLUGIN_UI_APP_DECLARATIONS: readonly PluginHostBundledUiDeclaration[];
export declare const BUNDLED_PLUGIN_BRAND_MARKS: readonly BundledPluginBrandMark[];
/** Manifest-declared packaged Resource locators, loaded through the shared Asset reader. */
export declare const BUNDLED_PLUGIN_PACKAGED_RESOURCES: readonly BundledPluginPackagedResource[];
