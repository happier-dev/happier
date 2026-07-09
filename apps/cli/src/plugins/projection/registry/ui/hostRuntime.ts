import { createRequire } from 'node:module';
import type { FeatureDecision } from '@happier-dev/protocol';

import type { PluginUiArtifactRevocationState } from '@/plugins/install/ui/revocation';

import type { PluginUiProjectionHostRuntimeContext } from './projection';

const requireForResolution = createRequire(import.meta.url);
const REPACK_CLIENT_PACKAGE_NAME = '@callstack/repack/client';
const REPACK_UNAVAILABLE_DIAGNOSTIC = 'repack_script_manager_unavailable';
const REPACK_PACKAGE_MISSING_DIAGNOSTIC = 'repack_script_manager_package_missing';
const REPACK_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC =
    'repack_script_manager_installed_artifact_loader_unavailable';
const REPACK_RUNTIME_NOT_INTEGRATED_DIAGNOSTIC =
    'repack_script_manager_runtime_not_integrated';
const REACT_NATIVE_HOST_RUNTIME_IDENTITY_MISSING_DIAGNOSTIC =
    'react_native_host_runtime_identity_unavailable';

export const PLUGIN_UI_HOST_API_VERSION = '1.0.0';
export const PLUGIN_UI_REACT_VERSION = '19.2.0';
export const PLUGIN_UI_REACT_NATIVE_VERSION = '0.83.4';

export type ReactNativeRepackLoaderBackendAvailability = Readonly<
    | {
        available: true;
        diagnostics: readonly string[];
    }
    | {
        available: false;
        diagnostics: readonly string[];
        unavailableReason: string;
    }
>;

/**
 * Real deployment-CSP capability for in-process embedded-web plugin bundles.
 *
 * This replaces the prior fail-open shortcut (`allowsBlobModuleImport =
 * featureEnabled`). The CSP capability must come from a real signal about the
 * running web deployment (a CSP probe / build policy), never from the feature
 * flag. When absent it defaults fail-closed (both bits false), so a strict
 * deployment that forbids `script-src blob:` correctly refuses blob `import()`
 * instead of advertising it as allowed.
 */
export type EmbeddedWebDeploymentCspCapability = Readonly<{
    supportsSameOriginModuleUrl: boolean;
    allowsBlobModuleImport: boolean;
}>;

const FAIL_CLOSED_EMBEDDED_WEB_CSP_CAPABILITY: EmbeddedWebDeploymentCspCapability = Object.freeze({
    supportsSameOriginModuleUrl: false,
    allowsBlobModuleImport: false,
});

export type ReactNativeHostRuntimeReadinessIdentity = Readonly<{
    hostAppVersion?: string;
    reactVersion?: string;
    reactNativeVersion?: string;
    platform?: string;
    channel?: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    availableNativeCapabilities?: readonly string[];
    /**
     * ScriptManager readiness reported by the UI/native host probe (PR-13).
     * The daemon CONSUMES these reported bits to gate the RN loader backend; it
     * never asserts or infers them. Absent ⇒ fail-closed (gate stays shut).
     */
    scriptManagerRuntime?: Readonly<{
        integrated: boolean;
        installedArtifactLoaderAvailable: boolean;
    }>;
}>;

function defaultIsRepackClientPackageResolvable(): boolean {
    try {
        requireForResolution.resolve(REPACK_CLIENT_PACKAGE_NAME);
        return true;
    } catch {
        return false;
    }
}

function readNonEmptyString(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

export function resolveReactNativeRepackLoaderBackendAvailability(params?: Readonly<{
    isRepackClientPackageResolvable?: () => boolean;
    installedArtifactLoaderAvailable?: boolean;
    scriptManagerRuntimeIntegrated?: boolean;
}>): ReactNativeRepackLoaderBackendAvailability {
    const isRepackClientPackageResolvable =
        params?.isRepackClientPackageResolvable ?? defaultIsRepackClientPackageResolvable;
    if (!isRepackClientPackageResolvable()) {
        return Object.freeze({
            available: false,
            diagnostics: Object.freeze([
                REPACK_UNAVAILABLE_DIAGNOSTIC,
                REPACK_PACKAGE_MISSING_DIAGNOSTIC,
            ]),
            unavailableReason: `${REPACK_CLIENT_PACKAGE_NAME} is not installed in this checkout`,
        });
    }

    if (params?.installedArtifactLoaderAvailable !== true) {
        return Object.freeze({
            available: false,
            diagnostics: Object.freeze([
                REPACK_UNAVAILABLE_DIAGNOSTIC,
                REPACK_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC,
            ]),
            unavailableReason: 'Re.Pack ScriptManager is installed, but the host installed-artifact module loader is not wired',
        });
    }

    if (params?.scriptManagerRuntimeIntegrated !== true) {
        return Object.freeze({
            available: false,
            diagnostics: Object.freeze([
                REPACK_UNAVAILABLE_DIAGNOSTIC,
                REPACK_RUNTIME_NOT_INTEGRATED_DIAGNOSTIC,
            ]),
            unavailableReason: 'Re.Pack ScriptManager runtime is not integrated into the native host app',
        });
    }

    return Object.freeze({
        available: true,
        diagnostics: Object.freeze([]),
    });
}

export function resolvePluginUiProjectionHostRuntime(params: Readonly<{
    hostAppVersion: string;
    isRepackClientPackageResolvable?: () => boolean;
    installedArtifactLoaderAvailable?: boolean;
    scriptManagerRuntimeIntegrated?: boolean;
    reactNativeHostRuntime?: ReactNativeHostRuntimeReadinessIdentity;
    hostedWebFeatureDecision?: FeatureDecision;
    embeddedWebBundlesFeatureDecision?: FeatureDecision;
    reactNativeBundlesFeatureDecision?: FeatureDecision;
    reactNativeDevHotReloadFeatureDecision?: FeatureDecision;
    structuredMessagesFeatureDecision?: FeatureDecision;
    deploymentCspCapability?: EmbeddedWebDeploymentCspCapability;
    pluginUiArtifactRevocationState?: PluginUiArtifactRevocationState;
    reactNativeArtifactRevocationState?: PluginUiArtifactRevocationState;
    reactNativeCrashDisabledContributionIds?: readonly string[];
    reactNativeCrashDisabledByContributionId?: Readonly<Record<string, boolean>>;
}>): PluginUiProjectionHostRuntimeContext {
    const loaderBackend = resolveReactNativeRepackLoaderBackendAvailability(
        params.isRepackClientPackageResolvable
            || params.installedArtifactLoaderAvailable !== undefined
            || params.scriptManagerRuntimeIntegrated !== undefined
            ? {
                ...(params.isRepackClientPackageResolvable
                    ? { isRepackClientPackageResolvable: params.isRepackClientPackageResolvable }
                    : {}),
                ...(params.installedArtifactLoaderAvailable !== undefined
                    ? { installedArtifactLoaderAvailable: params.installedArtifactLoaderAvailable }
                    : {}),
                ...(params.scriptManagerRuntimeIntegrated !== undefined
                    ? { scriptManagerRuntimeIntegrated: params.scriptManagerRuntimeIntegrated }
                    : {}),
            }
            : undefined,
    );
    const crashDisabledContributionIds = Object.freeze([
        ...(params.reactNativeCrashDisabledContributionIds ?? []),
    ]);
    const crashDisabledByContributionId: Record<string, boolean> = {
        ...(params.reactNativeCrashDisabledByContributionId ?? {}),
    };
    for (const contributionId of crashDisabledContributionIds) {
        crashDisabledByContributionId[contributionId] = true;
    }
    const artifactRevocationState =
        params.pluginUiArtifactRevocationState ?? params.reactNativeArtifactRevocationState;
    const embeddedWebBundlesFeatureEnabled =
        params.embeddedWebBundlesFeatureDecision?.state === 'enabled';
    const embeddedWebDeploymentCsp =
        params.deploymentCspCapability ?? FAIL_CLOSED_EMBEDDED_WEB_CSP_CAPABILITY;
    const reactNativeRuntimePlatform = readNonEmptyString(params.reactNativeHostRuntime?.platform);
    const reactNativeRuntimeChannel = readNonEmptyString(params.reactNativeHostRuntime?.channel);
    const reactNativeHostRuntimeIdentityAvailable = Boolean(reactNativeRuntimePlatform && reactNativeRuntimeChannel);
    const reactNativeLoaderBackend = loaderBackend.available && !reactNativeHostRuntimeIdentityAvailable
        ? Object.freeze({
            available: false as const,
            diagnostics: Object.freeze([
                REPACK_UNAVAILABLE_DIAGNOSTIC,
                REACT_NATIVE_HOST_RUNTIME_IDENTITY_MISSING_DIAGNOSTIC,
            ]),
            unavailableReason: 'React Native host runtime platform and channel are not available',
        })
        : loaderBackend;
    return Object.freeze({
        hostedWeb: Object.freeze({
            featureEnabled: params.hostedWebFeatureDecision?.state === 'enabled',
        }),
        structuredMessages: Object.freeze({
            featureEnabled: params.structuredMessagesFeatureDecision?.state === 'enabled',
        }),
        embeddedWebBundles: Object.freeze({
            featureEnabled: embeddedWebBundlesFeatureEnabled,
            // Loader honesty: the embedded-web backend can only back a load when
            // the family feature is enabled, mirroring the RN family's gated
            // treatment instead of an unconditional `true`.
            loaderBackendAvailable: embeddedWebBundlesFeatureEnabled,
            ...(artifactRevocationState
                ? { revocationState: artifactRevocationState }
                : {}),
            // CSP capability comes from the real deployment signal, fail-closed
            // by default. The feature flag gates the family (above); it no
            // longer synthesizes the CSP capability.
            csp: Object.freeze({
                supportsSameOriginModuleUrl: embeddedWebDeploymentCsp.supportsSameOriginModuleUrl,
                allowsBlobModuleImport: embeddedWebDeploymentCsp.allowsBlobModuleImport,
            }),
            hostRuntime: Object.freeze({
                hostAppVersion: params.hostAppVersion,
                hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION,
                reactVersion: PLUGIN_UI_REACT_VERSION,
                platform: 'web',
                channel: 'internal',
            }),
        }),
        reactNativeBundles: Object.freeze({
            featureEnabled: params.reactNativeBundlesFeatureDecision?.state === 'enabled',
            // Phase 6.3: a separate author gate. Fail-closed: only `enabled` opens
            // the dev-server source, and only for a local plugin on the
            // development channel (enforced in the runtime projection).
            devHotReloadEnabled: params.reactNativeDevHotReloadFeatureDecision?.state === 'enabled',
            loaderBackendAvailable: reactNativeLoaderBackend.available,
            loaderBackendDiagnostics: reactNativeLoaderBackend.diagnostics,
            ...(artifactRevocationState
                ? { revocationState: artifactRevocationState }
                : {}),
            ...(crashDisabledContributionIds.length > 0
                ? { crashDisabledContributionIds }
                : {}),
            ...(Object.keys(crashDisabledByContributionId).length > 0
                ? { crashDisabledByContributionId: Object.freeze(crashDisabledByContributionId) }
                : {}),
            hostRuntime: Object.freeze({
                hostAppVersion: readNonEmptyString(params.reactNativeHostRuntime?.hostAppVersion)
                    ?? params.hostAppVersion,
                hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION,
                reactVersion: readNonEmptyString(params.reactNativeHostRuntime?.reactVersion)
                    ?? PLUGIN_UI_REACT_VERSION,
                reactNativeVersion: readNonEmptyString(params.reactNativeHostRuntime?.reactNativeVersion)
                    ?? PLUGIN_UI_REACT_NATIVE_VERSION,
                ...(reactNativeRuntimePlatform ? { platform: reactNativeRuntimePlatform } : {}),
                ...(reactNativeRuntimeChannel ? { channel: reactNativeRuntimeChannel } : {}),
                ...(readNonEmptyString(params.reactNativeHostRuntime?.expoRuntimeVersion)
                    ? { expoRuntimeVersion: readNonEmptyString(params.reactNativeHostRuntime?.expoRuntimeVersion) }
                    : {}),
                ...(readNonEmptyString(params.reactNativeHostRuntime?.hermesVersion)
                    ? { hermesVersion: readNonEmptyString(params.reactNativeHostRuntime?.hermesVersion) }
                    : {}),
                availableNativeCapabilities: Object.freeze([
                    ...(params.reactNativeHostRuntime?.availableNativeCapabilities ?? []),
                ]),
            }),
        }),
    });
}
