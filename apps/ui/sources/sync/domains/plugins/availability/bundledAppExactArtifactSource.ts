import { readBundledPluginUiAppArtifactAssetBytes } from './bundledPluginUiArtifactAssetReader';
import type {
    BundledPluginUiAppArtifact,
    BundledPluginUiAppArtifactInventory,
} from './bundledPluginUiArtifactInventory';
import { BUNDLED_PLUGIN_UI_APP_ARTIFACTS } from './generatedBundledPluginUiArtifacts';
import type { PluginArtifactSourceCandidate, PluginSelectedArtifactIdentity } from './artifactLease';

export type { BundledPluginUiAppArtifactInventory } from './bundledPluginUiArtifactInventory';

export type BundledPluginUiAppExactArtifactSource = PluginArtifactSourceCandidate & Readonly<{
    kind: 'appExact';
}>;

type ReadBundledAssetBytes = (
    asset: BundledPluginUiAppArtifact['files'][number]['asset'],
) => Promise<Uint8Array | null>;

function findExactArtifact(
    inventory: BundledPluginUiAppArtifactInventory,
    artifact: PluginSelectedArtifactIdentity,
): BundledPluginUiAppArtifact | null {
    // Several packaged release occurrences can contain the same immutable bytes.
    // Selection/admission belongs to the lease; these bytes ship inside the app.
    return inventory.find((candidate) => candidate.digest === artifact.digest) ?? null;
}

/**
 * The app-package byte source: the preseeded file set for the selected digest.
 * Build-owned digest addressing supplies already-admitted internal bytes;
 * selection and currentness remain with the lease.
 */
export function createBundledPluginUiAppExactArtifactSourceFromInventory(input: Readonly<{
    inventory: BundledPluginUiAppArtifactInventory;
    readBundledAssetBytes: ReadBundledAssetBytes;
}>): BundledPluginUiAppExactArtifactSource {
    return Object.freeze({
        kind: 'appExact' as const,
        fetch: async ({ artifact }) => {
            const candidate = findExactArtifact(input.inventory, artifact);
            if (!candidate) return null;
            const files = new Map<string, Uint8Array>();
            for (const file of candidate.files) {
                const bytes = await input.readBundledAssetBytes(file.asset);
                if (!bytes) return null;
                files.set(file.relativePath, bytes);
            }
            return files;
        },
    });
}

/** The app build's generated immutable byte inventory exposed as one appExact candidate. */
export function createBundledPluginUiAppExactArtifactSource(): BundledPluginUiAppExactArtifactSource {
    return createBundledPluginUiAppExactArtifactSourceFromInventory({
        inventory: BUNDLED_PLUGIN_UI_APP_ARTIFACTS,
        readBundledAssetBytes: readBundledPluginUiAppArtifactAssetBytes,
    });
}
