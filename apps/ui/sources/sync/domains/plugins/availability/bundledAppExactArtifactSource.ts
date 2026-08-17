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

function matchesImmutableArtifact(
    candidate: BundledPluginUiAppArtifact,
    artifact: PluginSelectedArtifactIdentity,
): boolean {
    return candidate.pluginId === artifact.pluginId
        && candidate.contributionId === artifact.contributionId
        && candidate.tier === artifact.tier
        && candidate.platform === artifact.platform
        && candidate.digest === artifact.digest
        && candidate.releaseVersion === artifact.releaseVersion;
}

function findExactArtifact(
    inventory: BundledPluginUiAppArtifactInventory,
    artifact: PluginSelectedArtifactIdentity,
): BundledPluginUiAppArtifact | null {
    const matches = inventory.filter((candidate) => matchesImmutableArtifact(candidate, artifact));
    return matches.length === 1 ? matches[0]! : null;
}

/**
 * Narrow app-package source adapter. It has no cache, daemon, Account,
 * selection, currentness, integrity, or graph-validation authority; the
 * Artifact lease owns all of those concerns and passes only a selected exact
 * identity plus a declared path here.
 */
export function createBundledPluginUiAppExactArtifactSourceFromInventory(input: Readonly<{
    inventory: BundledPluginUiAppArtifactInventory;
    readBundledAssetBytes: ReadBundledAssetBytes;
}>): BundledPluginUiAppExactArtifactSource {
    return Object.freeze({
        kind: 'appExact' as const,
        readFile: async ({ artifact, relativePath }) => {
            const candidate = findExactArtifact(input.inventory, artifact);
            if (!candidate) return null;
            const file = candidate.files.find((entry) => entry.relativePath === relativePath);
            if (!file) return null;
            const bytes = await input.readBundledAssetBytes(file.asset);
            if (!bytes) return null;
            return new Uint8Array(bytes);
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
