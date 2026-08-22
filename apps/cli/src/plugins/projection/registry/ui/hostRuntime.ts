import {
    DaemonHostedWebFrameCapabilityV1Schema,
    type DaemonHostedWebFrameCapabilityV1,
    type FeatureDecision,
} from '@happier-dev/protocol';
import type {
    PluginUiChannelV1,
    PluginUiPlatformV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginUiProjectionHostRuntimeContext } from './projection';
import {
    PLUGIN_UI_HOST_API_VERSION,
    PLUGIN_UI_REACT_NATIVE_VERSION,
    PLUGIN_UI_REACT_VERSION,
} from './artifactCompatibility';

const REPACK_UNAVAILABLE_DIAGNOSTIC = 'repack_script_manager_unavailable';
const REPACK_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC =
    'repack_script_manager_installed_artifact_loader_unavailable';
const REPACK_RUNTIME_NOT_INTEGRATED_DIAGNOSTIC =
    'repack_script_manager_runtime_not_integrated';
const REACT_NATIVE_HOST_RUNTIME_IDENTITY_MISSING_DIAGNOSTIC =
    'react_native_host_runtime_identity_unavailable';
const REACT_NATIVE_WEB_LOADER_UNAVAILABLE_DIAGNOSTIC = 'react_native_web_loader_unavailable';
const REACT_NATIVE_WEB_LOADER_NOT_INTEGRATED_DIAGNOSTIC = 'react_native_web_loader_not_integrated';
const REACT_NATIVE_WEB_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC =
    'react_native_web_installed_artifact_loader_unavailable';

export {
    PLUGIN_UI_HOST_API_VERSION,
    PLUGIN_UI_REACT_NATIVE_VERSION,
    PLUGIN_UI_REACT_VERSION,
} from './artifactCompatibility';

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

export type ReactNativeHostRuntimeReadinessIdentity = Readonly<{
    hostAppVersion?: string;
    reactVersion?: string;
    reactNativeVersion?: string;
    platform?: PluginUiPlatformV1;
    channel?: PluginUiChannelV1;
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

function readNonEmptyString(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function createReactNativeWebHostRuntimeIdentity(): ReactNativeHostRuntimeReadinessIdentity {
    const identity: ReactNativeHostRuntimeReadinessIdentity = {
        platform: 'web',
        channel: 'internal',
    };
    return Object.freeze(identity);
}

export function resolveReactNativeRepackLoaderBackendAvailability(params?: Readonly<{
    installedArtifactLoaderAvailable?: boolean;
    scriptManagerRuntimeIntegrated?: boolean;
}>): ReactNativeRepackLoaderBackendAvailability {
    if (params?.installedArtifactLoaderAvailable !== true) {
        return Object.freeze({
            available: false,
            diagnostics: Object.freeze([
                REPACK_UNAVAILABLE_DIAGNOSTIC,
                REPACK_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC,
            ]),
            unavailableReason: 'The native host installed-artifact module loader is not wired',
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
    installedArtifactLoaderAvailable?: boolean;
    scriptManagerRuntimeIntegrated?: boolean;
    reactNativeHostRuntime?: ReactNativeHostRuntimeReadinessIdentity;
    reactNativeWebLoaderCapability?: Readonly<{
        integrated: boolean;
        installedArtifactLoaderAvailable: boolean;
    }>;
    /**
     * Observed only by the exact physical frame adapter. This remains a
     * transport fact; server Artifact hosting and Account admission are owned
     * by their existing later-stage consumers.
     */
    hostedWebFrameCapability?: DaemonHostedWebFrameCapabilityV1;
    hostedWebFeatureDecision?: FeatureDecision;
    reactNativeBundlesFeatureDecision?: FeatureDecision;
    reactNativeDevHotReloadFeatureDecision?: FeatureDecision;
}>): PluginUiProjectionHostRuntimeContext {
    const loaderBackend: ReactNativeRepackLoaderBackendAvailability = params.reactNativeWebLoaderCapability
        ? params.reactNativeWebLoaderCapability.integrated !== true
            ? Object.freeze({
                available: false as const,
                diagnostics: Object.freeze([
                    REACT_NATIVE_WEB_LOADER_UNAVAILABLE_DIAGNOSTIC,
                    REACT_NATIVE_WEB_LOADER_NOT_INTEGRATED_DIAGNOSTIC,
                ]),
                unavailableReason: 'React Native web module loading is not integrated into the web host',
            })
            : params.reactNativeWebLoaderCapability.installedArtifactLoaderAvailable !== true
                ? Object.freeze({
                    available: false as const,
                    diagnostics: Object.freeze([
                        REACT_NATIVE_WEB_LOADER_UNAVAILABLE_DIAGNOSTIC,
                        REACT_NATIVE_WEB_INSTALLED_ARTIFACT_LOADER_MISSING_DIAGNOSTIC,
                    ]),
                    unavailableReason: 'The web host cannot load installed React Native artifacts',
                })
                : Object.freeze({
                    available: true as const,
                    diagnostics: Object.freeze([]),
                })
        : resolveReactNativeRepackLoaderBackendAvailability(
            params.installedArtifactLoaderAvailable !== undefined
                || params.scriptManagerRuntimeIntegrated !== undefined
                ? {
                    ...(params.installedArtifactLoaderAvailable !== undefined
                        ? { installedArtifactLoaderAvailable: params.installedArtifactLoaderAvailable }
                        : {}),
                    ...(params.scriptManagerRuntimeIntegrated !== undefined
                        ? { scriptManagerRuntimeIntegrated: params.scriptManagerRuntimeIntegrated }
                        : {}),
                }
                : undefined,
        );
    const webLoaderReady = params.reactNativeWebLoaderCapability?.integrated === true
        && params.reactNativeWebLoaderCapability.installedArtifactLoaderAvailable === true;
    const webHostRuntime: ReactNativeHostRuntimeReadinessIdentity | undefined = webLoaderReady
        ? createReactNativeWebHostRuntimeIdentity()
        : undefined;
    const effectiveReactNativeHostRuntime: ReactNativeHostRuntimeReadinessIdentity | undefined =
        params.reactNativeHostRuntime ?? webHostRuntime;
    const reactNativeRuntimePlatform = effectiveReactNativeHostRuntime?.platform;
    const reactNativeRuntimeChannel = effectiveReactNativeHostRuntime?.channel;
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
    const hostedWebFrameCapability = DaemonHostedWebFrameCapabilityV1Schema.safeParse(
        params.hostedWebFrameCapability,
    );
    return Object.freeze({
        hostedWeb: Object.freeze({
            featureEnabled: params.hostedWebFeatureDecision?.state === 'enabled',
            ...(hostedWebFrameCapability.success
                ? {
                    frameCapability: Object.freeze(hostedWebFrameCapability.data),
                }
                : {}),
        }),
        reactNativeBundles: Object.freeze({
            featureEnabled: params.reactNativeBundlesFeatureDecision?.state === 'enabled',
            // Phase 6.3: a separate author gate. Fail-closed: only `enabled` opens
            // the dev-server source, and only for a local plugin on the
            // development channel (enforced in the runtime projection).
            devHotReloadEnabled: params.reactNativeDevHotReloadFeatureDecision?.state === 'enabled',
            loaderBackendAvailable: reactNativeLoaderBackend.available,
            loaderBackendDiagnostics: reactNativeLoaderBackend.diagnostics,
            hostRuntime: Object.freeze({
                hostAppVersion: readNonEmptyString(effectiveReactNativeHostRuntime?.hostAppVersion)
                    ?? params.hostAppVersion,
                hostUiApiVersion: PLUGIN_UI_HOST_API_VERSION,
                reactVersion: readNonEmptyString(effectiveReactNativeHostRuntime?.reactVersion)
                    ?? PLUGIN_UI_REACT_VERSION,
                reactNativeVersion: readNonEmptyString(effectiveReactNativeHostRuntime?.reactNativeVersion)
                    ?? PLUGIN_UI_REACT_NATIVE_VERSION,
                ...(reactNativeRuntimePlatform ? { platform: reactNativeRuntimePlatform } : {}),
                ...(reactNativeRuntimeChannel ? { channel: reactNativeRuntimeChannel } : {}),
                ...(readNonEmptyString(effectiveReactNativeHostRuntime?.expoRuntimeVersion)
                    ? { expoRuntimeVersion: readNonEmptyString(effectiveReactNativeHostRuntime?.expoRuntimeVersion) }
                    : {}),
                ...(readNonEmptyString(effectiveReactNativeHostRuntime?.hermesVersion)
                    ? { hermesVersion: readNonEmptyString(effectiveReactNativeHostRuntime?.hermesVersion) }
                    : {}),
                availableNativeCapabilities: Object.freeze([
                    ...(effectiveReactNativeHostRuntime?.availableNativeCapabilities ?? []),
                ]),
            }),
        }),
    });
}
