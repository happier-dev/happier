export type PluginUiArtifactRevocationState = Readonly<{
    revokedDigests: ReadonlySet<string>;
}>;

export function createEmptyPluginUiArtifactRevocationState(): PluginUiArtifactRevocationState {
    return Object.freeze({
        revokedDigests: new Set<string>(),
    });
}
