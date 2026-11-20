import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol/plugins/ui';

type ArtifactDigest = `sha256:${string}`;

export type PluginReactNativeLocalFailure = 'render_error' | 'invalid_surface_module' | 'load_error';

export type PluginReactNativeWatchdog = Readonly<{
    recordFailure: (input: Readonly<{ artifactDigest: ArtifactDigest; failure: PluginReactNativeLocalFailure }>) => void;
    clear: (input: Readonly<{ artifactDigest: ArtifactDigest }>) => void;
    readFailure: (input: Readonly<{ artifactDigest: ArtifactDigest }>) => PluginReactNativeLocalFailure | null;
}>;

export function createPluginReactNativeWatchdog(): PluginReactNativeWatchdog {
    const containedDigests = new Map<ArtifactDigest, PluginReactNativeLocalFailure>();

    return Object.freeze({
        recordFailure(input) {
            containedDigests.set(PluginUiArtifactDigestV1Schema.parse(input.artifactDigest), input.failure);
        },
        clear(input) {
            containedDigests.delete(PluginUiArtifactDigestV1Schema.parse(input.artifactDigest));
        },
        readFailure(input) {
            return containedDigests.get(PluginUiArtifactDigestV1Schema.parse(input.artifactDigest)) ?? null;
        },
    });
}
