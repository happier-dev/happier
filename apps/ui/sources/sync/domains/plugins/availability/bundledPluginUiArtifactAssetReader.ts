import { readBundledAssetBytes } from '@/utils/assets/readBundledAssetBytes';

import type { BundledPluginUiAppArtifactFile, PluginHostBundledUiDeclaration } from './bundledPluginUiArtifactInventory';

export { readBundledAssetBytes as readBundledPluginUiAppArtifactAssetBytes } from '@/utils/assets/readBundledAssetBytes';

/** The build-owned declaration is trusted data; selection stays with its caller. */
export async function readBundledPluginUiDeclarationAsset(
    asset: BundledPluginUiAppArtifactFile['asset'],
): Promise<PluginHostBundledUiDeclaration> {
    const bytes = await readBundledAssetBytes(asset);
    if (!bytes) throw new Error('Bundled plugin declaration asset is unavailable');
    return JSON.parse(new TextDecoder().decode(bytes));
}
