import type {
    PluginReactNativeBundleCache,
    PluginReactNativeBundleCacheIdentity,
} from './bundleCache';
import type { PluginReactNativePluginSource } from './runtimePolicy';

export type PluginReactNativeHotReloadInvalidationResult = Readonly<{
    invalidated: boolean;
    diagnostics: readonly string[];
}>;

export function applyPluginReactNativeHotReloadInvalidation(input: Readonly<{
    cache: PluginReactNativeBundleCache;
    identity: PluginReactNativeBundleCacheIdentity;
    devHotReloadEnabled: boolean;
    pluginSource: PluginReactNativePluginSource;
    channel: string;
}>): PluginReactNativeHotReloadInvalidationResult {
    if (!input.devHotReloadEnabled || input.pluginSource !== 'local' || input.channel !== 'development') {
        return Object.freeze({
            invalidated: false,
            diagnostics: Object.freeze(['dev_hot_reload_denied']),
        });
    }

    input.cache.evictForPluginDisable(input.identity.pluginId);
    return Object.freeze({
        invalidated: true,
        diagnostics: Object.freeze([]),
    });
}
