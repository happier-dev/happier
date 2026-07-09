import type { PluginUiArtifactTrustRootV1 } from '@happier-dev/protocol';

import {
    validateInstalledReactNativeBundleArtifact,
    type ReactNativeBundleCacheIdentity,
    type ReactNativeBundleArtifactExecutionTrust,
    type ReactNativeBundleHostRuntime,
} from '@/plugins/install/ui/reactNativeBundles';
import type { PluginUiArtifactRevocationState } from '@/plugins/install/ui/revocation';

type ReactNativeRuntimeBundleProjection = Readonly<{
    pluginId: string;
    contributionId: string;
    fallback?: unknown;
}>;

export type ReactNativeBundleRuntimeProjection =
    | Readonly<{
        state: 'loadable';
        diagnostics: readonly string[];
        cacheKey: string;
        cacheIdentity: ReactNativeBundleCacheIdentity;
        loadPolicy: Readonly<{
            source: 'installedArtifact';
            featureEnabled: true;
            loaderBackendAvailable: true;
        }>;
    }>
    | Readonly<{
        // Phase 6.3 author affordance: a development-channel bundle served by a
        // local dev server. Trust is the local install + the explicit
        // `plugins.ui.reactNativeBundles.devHotReload` gate, scoped to a local
        // plugin source on the development channel only — never a user feature
        // path. No installed artifact cache identity: the host loads from the
        // dev URL through the RN ScriptManager dev backend.
        state: 'loadable';
        diagnostics: readonly string[];
        loadPolicy: Readonly<{
            source: 'devHotReload';
            devUrl: string;
            featureEnabled: true;
            loaderBackendAvailable: true;
        }>;
    }>
    | Readonly<{
        state: 'fallback' | 'blocked' | 'disabled';
        diagnostics: readonly string[];
        cacheKey?: string;
        cacheIdentity?: ReactNativeBundleCacheIdentity;
        loadPolicy?: Readonly<{
            source: 'installedArtifact' | 'devHotReload';
            featureEnabled: boolean;
            loaderBackendAvailable: boolean;
            devUrl?: string;
        }>;
    }>;

/**
 * Phase 6.3: resolve whether a development-channel bundle is eligible for the
 * dev-hot-reload source. The dev-server source is authorised ONLY when the
 * `devHotReload` gate is on AND the plugin source is local AND the channel is
 * `development` AND the artifact actually advertises a dev URL — an author
 * affordance, fail-closed for everything else.
 */
function resolveDevHotReloadProjection(params: Readonly<{
    devHotReloadEnabled: boolean;
    pluginSource: 'local' | 'internal' | 'marketplace' | 'external' | undefined;
    channel: string;
    devUrl: string | undefined;
    loaderBackendAvailable: boolean;
}>): ReactNativeBundleRuntimeProjection | null {
    const devUrl = params.devUrl?.trim();
    if (!devUrl) {
        return null;
    }
    if (!params.devHotReloadEnabled || params.pluginSource !== 'local' || params.channel !== 'development') {
        return Object.freeze({
            state: 'fallback',
            diagnostics: Object.freeze(['dev_hot_reload_denied']),
        });
    }
    if (!params.loaderBackendAvailable) {
        return Object.freeze({
            state: 'fallback',
            diagnostics: Object.freeze(['repack_script_manager_unavailable']),
            loadPolicy: Object.freeze({
                source: 'devHotReload',
                devUrl,
                featureEnabled: true,
                loaderBackendAvailable: false,
            }),
        });
    }
    return Object.freeze({
        state: 'loadable',
        diagnostics: Object.freeze([]),
        loadPolicy: Object.freeze({
            source: 'devHotReload',
            devUrl,
            featureEnabled: true,
            loaderBackendAvailable: true,
        }),
    });
}

function hasFallback(bundle: ReactNativeRuntimeBundleProjection): boolean {
    return Boolean(bundle.fallback && typeof bundle.fallback === 'object');
}

function readArtifactDevUrl(artifact: unknown): string | undefined {
    if (!artifact || typeof artifact !== 'object') {
        return undefined;
    }
    const devUrl = (artifact as Readonly<{ devUrl?: unknown }>).devUrl;
    return typeof devUrl === 'string' && devUrl.trim().length > 0 ? devUrl.trim() : undefined;
}

export function resolveReactNativeBundleRuntimeProjection(params: Readonly<{
    bundle: ReactNativeRuntimeBundleProjection;
    artifact: unknown;
    hostRuntime: ReactNativeBundleHostRuntime;
    featureEnabled: boolean;
    loaderBackendAvailable: boolean;
    loaderBackendDiagnostics?: readonly string[];
    revokedDigests: ReadonlySet<string>;
    revocationState?: PluginUiArtifactRevocationState;
    executionTrust?: ReactNativeBundleArtifactExecutionTrust;
    signatureTrustRoots?: readonly PluginUiArtifactTrustRootV1[];
    crashDisabled: boolean;
    devHotReloadEnabled?: boolean;
    pluginSource?: 'local' | 'internal' | 'marketplace' | 'external';
}>): ReactNativeBundleRuntimeProjection {
    if (!hasFallback(params.bundle)) {
        return Object.freeze({ state: 'blocked', diagnostics: Object.freeze(['fallback_required']) });
    }
    if (!params.featureEnabled) {
        return Object.freeze({ state: 'fallback', diagnostics: Object.freeze(['feature_disabled']) });
    }
    if (params.crashDisabled) {
        return Object.freeze({ state: 'disabled', diagnostics: Object.freeze(['crash_threshold_reached']) });
    }

    // Phase 6.3: a development-channel artifact advertising a dev URL takes the
    // dev-hot-reload path (scoped to local + dev-channel + gate-enabled) instead
    // of installed-artifact validation, which requires an installed asset that a
    // dev-server bundle does not carry.
    const devUrl = readArtifactDevUrl(params.artifact);
    if (devUrl) {
        const devHotReload = resolveDevHotReloadProjection({
            devHotReloadEnabled: params.devHotReloadEnabled === true,
            pluginSource: params.pluginSource,
            channel: params.hostRuntime.channel,
            devUrl,
            loaderBackendAvailable: params.loaderBackendAvailable,
        });
        if (devHotReload) {
            return devHotReload;
        }
    }

    const validation = validateInstalledReactNativeBundleArtifact({
        artifact: params.artifact,
        expectedPluginId: params.bundle.pluginId,
        expectedContributionId: params.bundle.contributionId,
        hostRuntime: params.hostRuntime,
        revokedDigests: params.revokedDigests,
        ...(params.revocationState ? { revocationState: params.revocationState } : {}),
        ...(params.executionTrust ? { executionTrust: params.executionTrust } : {}),
        ...(params.signatureTrustRoots?.length ? { signatureTrustRoots: params.signatureTrustRoots } : {}),
    });
    if (!validation.ok) {
        return Object.freeze({ state: 'fallback', diagnostics: Object.freeze([validation.code]) });
    }
    if (!params.loaderBackendAvailable) {
        return Object.freeze({
            state: 'fallback',
            diagnostics: Object.freeze(
                params.loaderBackendDiagnostics?.length
                    ? [...new Set(params.loaderBackendDiagnostics)]
                    : ['repack_script_manager_unavailable'],
            ),
            cacheKey: validation.cacheKey,
            cacheIdentity: validation.cacheIdentity,
            loadPolicy: Object.freeze({
                source: 'installedArtifact',
                featureEnabled: params.featureEnabled,
                loaderBackendAvailable: false,
            }),
        });
    }

    return Object.freeze({
        state: 'loadable',
        diagnostics: Object.freeze([]),
        cacheKey: validation.cacheKey,
        cacheIdentity: validation.cacheIdentity,
        loadPolicy: Object.freeze({
            source: 'installedArtifact',
            featureEnabled: true,
            loaderBackendAvailable: true,
        }),
    });
}
