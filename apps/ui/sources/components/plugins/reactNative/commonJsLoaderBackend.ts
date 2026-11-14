import type { PluginReactNativeLoaderBackend } from './loader';

/** The sole installed executable-artifact backend on web, iOS, and Android. */
export function createPluginUiCommonJsLoaderBackend(): PluginReactNativeLoaderBackend {
    return Object.freeze({
        backendId: 'commonJs',
        available: true,
        diagnostics: Object.freeze([]),
        // Current active/pending reuse belongs to the executable activation host. The compiled
        // program is the byte owner's (one per digest); every load still runs it in a fresh namespace.
        loadInstalledBundle: async (input) => {
            const { compilePluginUiCommonJsBundle, instantiatePluginUiCommonJsProgram } = await import('./commonJsEvaluator');
            const requestedExport = input.moduleReference?.exportName ?? 'renderSurface';
            const identity = {
                pluginId: input.identity.pluginId,
                artifactId: input.identity.artifactId,
                digest: input.identity.artifactDigest,
            };
            const compile = (bytes: Uint8Array) => compilePluginUiCommonJsBundle({ bytes, identity, requestedExport });
            const program = input.readProgram?.(compile) ?? compile(input.bytes);
            return instantiatePluginUiCommonJsProgram(program, { requestedExport }).readExport(requestedExport);
        },
    });
}
