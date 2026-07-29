export type PluginReactNativeLoaderSource =
    | 'installedArtifact'
    | 'devHotReload';

export type PluginReactNativeLoaderPolicyInput = Readonly<{
    source: PluginReactNativeLoaderSource;
    /**
     * RN-2: the local dev-server `AccessEndpoint` URL a `devHotReload` source loads
     * from. Propagated from the cli projection's dev-hot-reload loadPolicy (which is
     * gated on `plugins.ui.reactNativeBundles.devHotReload` + local + development).
     * A `devHotReload` source without a dev URL is never loadable.
     */
    devUrl?: string;
}>;

export type PluginReactNativeLoaderPolicyDecision = Readonly<{
    canLoad: boolean;
    diagnostics: readonly string[];
}>;

export function resolvePluginReactNativeLoaderPolicy(
    input: PluginReactNativeLoaderPolicyInput | null | undefined,
): PluginReactNativeLoaderPolicyDecision {
    if (!input) {
        return Object.freeze({ canLoad: true, diagnostics: Object.freeze([]) });
    }
    if (input.source === 'installedArtifact') {
        return Object.freeze({ canLoad: true, diagnostics: Object.freeze([]) });
    }
    if (input.source === 'devHotReload') {
        // The daemon projection owns the local/development/feature decision. The UI
        // requires its projected URL; the actual loader owns backend availability.
        if (!input.devUrl || input.devUrl.trim().length === 0) {
            return Object.freeze({ canLoad: false, diagnostics: Object.freeze(['dev_hot_reload_dev_url_missing']) });
        }
        return Object.freeze({ canLoad: true, diagnostics: Object.freeze([]) });
    }

    return Object.freeze({
        canLoad: false,
        diagnostics: Object.freeze(['unsupported_loader_source']),
    });
}
