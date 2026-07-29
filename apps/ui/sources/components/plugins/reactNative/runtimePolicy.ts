import type { PluginReactNativeCompatibilityDecisionStateV1 } from '@happier-dev/protocol';

export type PluginReactNativeRuntimeSource =
    | Readonly<{ kind: 'installedArtifact' }>
    | Readonly<{ kind: 'devHotReload' }>
    | Readonly<{ kind: 'remoteUrl' }>;

export type PluginReactNativePluginSource = 'internal' | 'local' | 'marketplace' | 'external';

export type PluginReactNativeRuntimePolicyDecision = Readonly<{
    canLoad: boolean;
    canHotReload: boolean;
    diagnostics: readonly string[];
}>;

export function resolvePluginReactNativeRuntimePolicy(input: Readonly<{
    source: PluginReactNativeRuntimeSource;
    featureEnabled: boolean;
    devHotReloadEnabled: boolean;
    pluginSource: PluginReactNativePluginSource;
    buildChannel: string;
    platform: string;
    loaderBackendAvailable: boolean;
    compatibilityState: PluginReactNativeCompatibilityDecisionStateV1;
    fallbackRequired: boolean;
}>): PluginReactNativeRuntimePolicyDecision {
    const diagnostics: string[] = [];

    if (input.source.kind === 'remoteUrl') {
        diagnostics.push('remote_url_unsupported');
    }
    if (!input.featureEnabled) {
        diagnostics.push('feature_disabled');
    }
    if (input.fallbackRequired) {
        diagnostics.push('fallback_required');
    }
    if (input.compatibilityState !== 'load') {
        diagnostics.push('compatibility_not_loadable');
    }
    if (!input.loaderBackendAvailable) {
        diagnostics.push('repack_script_manager_unavailable');
    }
    if ((input.platform !== 'ios' && input.platform !== 'android') || input.buildChannel === 'store') {
        diagnostics.push('channel_denied');
    }
    if (input.source.kind === 'devHotReload') {
        if (!input.devHotReloadEnabled || input.pluginSource !== 'local' || input.buildChannel !== 'development') {
            diagnostics.push('dev_hot_reload_denied');
        }
    } else if (input.pluginSource === 'marketplace' && input.buildChannel !== 'internal') {
        diagnostics.push('channel_denied');
    }

    return Object.freeze({
        canLoad: diagnostics.length === 0,
        canHotReload: diagnostics.length === 0 && input.source.kind === 'devHotReload',
        diagnostics: Object.freeze([...new Set(diagnostics)]),
    });
}
