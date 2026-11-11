import type { PluginReactNativeLoaderBackend } from './loader';

/** The sole installed executable-artifact backend on web, iOS, and Android. */
export function createPluginUiCommonJsLoaderBackend(): PluginReactNativeLoaderBackend {
    return Object.freeze({
        backendId: 'commonJs',
        available: true,
        diagnostics: Object.freeze([]),
        // Current active/pending reuse belongs to the executable activation host.
        loadInstalledBundle: async (input) => {
            const { evaluatePluginUiCommonJsBundle } = await import('./commonJsEvaluator');
            return evaluatePluginUiCommonJsBundle({
                bytes: input.bytes,
                identity: {
                    pluginId: input.identity.pluginId,
                    artifactId: input.identity.artifactId,
                    digest: input.identity.artifactDigest,
                },
                requestedExport: input.moduleReference?.exportName ?? 'renderSurface',
            });
        },
    });
}
