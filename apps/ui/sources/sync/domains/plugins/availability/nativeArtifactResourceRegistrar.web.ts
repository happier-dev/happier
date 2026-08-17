import type { PluginNativeArtifactResourceRegistrar } from './nativeArtifactResource';

/** Browser builds have no native Artifact handler and must remain fail-closed. */
export function createExpoPluginNativeArtifactResourceRegistrar(): PluginNativeArtifactResourceRegistrar {
    return Object.freeze({
        register: async () => Object.freeze({
            kind: 'unavailable' as const,
            code: 'native_artifact_resource_registration_failed' as const,
        }),
        unregister: () => false,
    });
}
