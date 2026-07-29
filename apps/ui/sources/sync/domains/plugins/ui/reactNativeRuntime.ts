import type {
    PluginReactNativeCompatibilityDecisionReasonV1,
    PluginReactNativeCompatibilityDecisionStateV1,
} from '@happier-dev/protocol';
import {
    isExecutablePluginUiFallbackRefV1,
    type PluginUiFallbackRefV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginReactNativeHostCompatibilityInput = Readonly<{
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: string;
    channel: string;
    availableNativeCapabilities: readonly string[];
    featureState: 'enabled' | 'disabled' | 'unknown';
    crashThreshold: number;
}>;

export type PluginReactNativeBundleCompatibilityInput = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactDigest: string;
    compatibility: Readonly<{
        hostUiApiVersion: string;
        reactVersion: string;
        reactNativeVersion: string;
        expoRuntimeVersion?: string;
        hermesVersion?: string;
        supportedPlatforms: readonly string[];
        supportedChannels: readonly string[];
        requiredNativeCapabilities?: readonly string[];
    }>;
    fallback?: PluginUiFallbackRefV1;
}>;

export type PluginReactNativeCompatibilityDecision = Readonly<{
    state: PluginReactNativeCompatibilityDecisionStateV1;
    reason: PluginReactNativeCompatibilityDecisionReasonV1;
    fallback?: PluginUiFallbackRefV1;
    diagnostics: readonly string[];
}>;

export type PluginReactNativeBundleCacheIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactDigest: string;
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: string;
    channel: string;
    nativeCapabilitiesDigest: string;
    projectionGeneration: number;
}>;

function decision(
    state: PluginReactNativeCompatibilityDecisionStateV1,
    reason: PluginReactNativeCompatibilityDecisionReasonV1,
    fallback: PluginUiFallbackRefV1 | undefined,
    diagnostics: readonly string[] = [],
): PluginReactNativeCompatibilityDecision {
    return Object.freeze({
        state,
        reason,
        ...(fallback ? { fallback } : {}),
        diagnostics: Object.freeze([...diagnostics]),
    });
}

function versionMismatch(
    host: PluginReactNativeHostCompatibilityInput,
    bundle: PluginReactNativeBundleCompatibilityInput,
): string | null {
    const compatibility = bundle.compatibility;
    if (host.hostUiApiVersion !== compatibility.hostUiApiVersion) return 'hostUiApiVersion';
    if (host.reactVersion !== compatibility.reactVersion) return 'reactVersion';
    if (host.reactNativeVersion !== compatibility.reactNativeVersion) return 'reactNativeVersion';
    if (compatibility.expoRuntimeVersion && host.expoRuntimeVersion !== compatibility.expoRuntimeVersion) {
        return 'expoRuntimeVersion';
    }
    if (compatibility.hermesVersion && host.hermesVersion !== compatibility.hermesVersion) {
        return 'hermesVersion';
    }
    return null;
}

export function resolvePluginReactNativeBundleRuntimeDecision(params: Readonly<{
    host: PluginReactNativeHostCompatibilityInput;
    bundle: PluginReactNativeBundleCompatibilityInput;
    previousCrashCount: number;
}>): PluginReactNativeCompatibilityDecision {
    const fallback = params.bundle.fallback;
    if (!isExecutablePluginUiFallbackRefV1(fallback)) {
        return decision('blocked', 'unknown', undefined, ['fallback_required']);
    }
    if (params.host.featureState !== 'enabled') {
        return decision('fallback', 'feature_disabled', fallback, ['feature_disabled']);
    }
    if (params.previousCrashCount >= params.host.crashThreshold) {
        return decision('disabled', 'crash_disabled', fallback, ['crash_threshold_reached']);
    }
    if (!params.bundle.compatibility.supportedPlatforms.includes(params.host.platform)) {
        return decision('fallback', 'channel_policy_denied', fallback, ['platform_denied']);
    }
    if (!params.bundle.compatibility.supportedChannels.includes(params.host.channel)) {
        return decision('fallback', 'channel_policy_denied', fallback, ['channel_denied']);
    }

    const mismatch = versionMismatch(params.host, params.bundle);
    if (mismatch) {
        return decision('fallback', 'runtime_mismatch', fallback, [mismatch]);
    }

    const available = new Set(params.host.availableNativeCapabilities);
    const missingCapability = (params.bundle.compatibility.requiredNativeCapabilities ?? [])
        .find((capability) => !available.has(capability));
    if (missingCapability) {
        return decision('fallback', 'missing_native_capability', fallback, [missingCapability]);
    }

    return decision('load', 'compatible', fallback);
}

export function derivePluginReactNativeBundleCacheIdentity(params: Readonly<{
    host: PluginReactNativeHostCompatibilityInput;
    bundle: PluginReactNativeBundleCompatibilityInput;
    nativeCapabilitiesDigest: string;
    projectionGeneration: number | null | undefined;
}>): PluginReactNativeBundleCacheIdentity {
    return Object.freeze({
        pluginId: params.bundle.pluginId,
        contributionId: params.bundle.contributionId,
        artifactDigest: params.bundle.artifactDigest,
        hostAppVersion: params.host.hostAppVersion,
        hostUiApiVersion: params.host.hostUiApiVersion,
        reactVersion: params.host.reactVersion,
        reactNativeVersion: params.host.reactNativeVersion,
        ...(params.host.expoRuntimeVersion ? { expoRuntimeVersion: params.host.expoRuntimeVersion } : {}),
        ...(params.host.hermesVersion ? { hermesVersion: params.host.hermesVersion } : {}),
        platform: params.host.platform,
        channel: params.host.channel,
        nativeCapabilitiesDigest: params.nativeCapabilitiesDigest,
        projectionGeneration: params.projectionGeneration ?? 0,
    });
}

export function derivePluginReactNativeBundleCacheKey(
    identity: PluginReactNativeBundleCacheIdentity,
): string {
    return [
        identity.pluginId,
        identity.contributionId,
        identity.artifactDigest,
        identity.hostAppVersion,
        identity.hostUiApiVersion,
        identity.reactVersion,
        identity.reactNativeVersion,
        identity.expoRuntimeVersion ?? '',
        identity.hermesVersion ?? '',
        identity.platform,
        identity.channel,
        identity.nativeCapabilitiesDigest,
        String(identity.projectionGeneration),
    ].join(':');
}
