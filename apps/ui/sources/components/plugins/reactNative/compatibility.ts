import type {
    PluginReactNativeCompatibilityDecisionReasonV1,
    PluginReactNativeCompatibilityDecisionStateV1,
} from '@happier-dev/protocol';

type PluginReactNativeHostCompatibilityInput = Readonly<{
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

type PluginReactNativeBundleCompatibilityInput = Readonly<{
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
    fallback?: Readonly<Record<string, unknown>>;
}>;

export type PluginReactNativeCompatibilityDecision = Readonly<{
    state: PluginReactNativeCompatibilityDecisionStateV1;
    reason: PluginReactNativeCompatibilityDecisionReasonV1;
    fallback?: Readonly<Record<string, unknown>>;
    diagnostics: readonly string[];
}>;

function decision(
    state: PluginReactNativeCompatibilityDecisionStateV1,
    reason: PluginReactNativeCompatibilityDecisionReasonV1,
    fallback: Readonly<Record<string, unknown>> | undefined,
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

export function resolvePluginReactNativeBundleCompatibility(params: Readonly<{
    host: PluginReactNativeHostCompatibilityInput;
    bundle: PluginReactNativeBundleCompatibilityInput;
    previousCrashCount: number;
    revokedDigests: ReadonlySet<string>;
}>): PluginReactNativeCompatibilityDecision {
    const fallback = params.bundle.fallback;
    if (params.revokedDigests.has(params.bundle.artifactDigest)) {
        return decision('blocked', 'artifact_revoked', fallback, ['artifact_revoked']);
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
