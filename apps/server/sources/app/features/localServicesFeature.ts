import type { FeaturesPayloadDelta } from "./types";
import {
    readLocalServicesFeatureEnv,
    readMachineTunnelFeatureEnv,
} from "./catalog/readFeatureEnv";
import {
    normalizeHttpUrl,
    resolveConfiguredCanonicalServerUrl,
} from "@/app/serverUrls/effectiveServerUrls";

function resolvePublicBaseUrl(env: NodeJS.ProcessEnv): string | null {
    return resolveConfiguredCanonicalServerUrl(env) ?? normalizeHttpUrl(String(env.PUBLIC_URL ?? ""));
}

function isHttpsUrl(value: string | null): boolean {
    if (!value) return false;
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

function hasProductionReadyPublicRateLimitChecker(
    env: NodeJS.ProcessEnv,
    dependencyKind: string,
    publicPreviewOptIn: boolean,
): boolean {
    if (dependencyKind === "none") {
        return false;
    }
    // V1 self-hosted opt-in: when the canonical `localServices.publicPreview` feature is enabled,
    // the relay is a single process, so the in-memory `fixed_window` limiter IS the shared limiter.
    // The production rejection encodes a hosted-multi-replica assumption that does not hold here;
    // a distributed limiter for true multi-tenant relays remains the (deferred) hardening path.
    if (publicPreviewOptIn) {
        return true;
    }
    return env.NODE_ENV !== "production" || dependencyKind !== "fixed_window";
}

export function resolveLocalServicesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readLocalServicesFeatureEnv(env);
    const tunnelConfig = readMachineTunnelFeatureEnv(env);
    // The core local-services product is server-represented + default-allow. Dependency
    // enforcement in resolveServerFeaturePayload cascades the parent off-state to children and
    // gates launcher behind preview, so emit the configured core gates directly.
    const localServicesEnabled = featureConfig.enabled;
    const pmsPreviewReady = featureConfig.previewEnabled
        && tunnelConfig.serverRoutedEnabled
        && tunnelConfig.allowedPorts.length > 0;
    const pmsDisabledReasons = (() => {
        if (!featureConfig.previewEnabled) return ["disabled_by_server_policy"];
        if (!tunnelConfig.serverRoutedEnabled) return ["pms_server_relay_disabled"];
        if (tunnelConfig.allowedPorts.length === 0) return ["pms_allowed_ports_empty"];
        return [];
    })();
    const publicDnsTlsHostModeAvailable = Boolean(featureConfig.previewHostOriginBaseDomain)
        && isHttpsUrl(resolvePublicBaseUrl(env));
    const publicDnsTlsRequired = featureConfig.publicPolicy.dnsTlsRequired || env.NODE_ENV === "production";
    const publicAllowedModesConfigured = featureConfig.publicPolicy.allowedModes.length > 0;
    const publicMaxTtlConfigured = typeof featureConfig.publicPolicy.maxTtlMs === "number";
    const publicAuditSinkAvailable = featureConfig.publicAuditDependency.kind !== "none";
    const publicAuditRequired = featureConfig.publicPolicy.auditRequired;
    const publicRateLimitProfileConfigured = featureConfig.publicPolicy.rateLimitProfileIds.length > 0;
    const publicRateLimitCheckerAvailable = hasProductionReadyPublicRateLimitChecker(
        env,
        featureConfig.publicRateLimitDependency.kind,
        featureConfig.publicPreviewEnabled,
    );
    const publicDisabledReasons = (() => {
        if (!featureConfig.publicPreviewEnabled) return ["disabled_by_server_policy"];
        return [
            ...pmsDisabledReasons,
            ...(
                publicAllowedModesConfigured
                    ? []
                    : ["mode_unconfigured"]
            ),
            ...(
                publicMaxTtlConfigured
                    ? []
                    : ["max_ttl_unconfigured"]
            ),
            ...(
                publicDnsTlsRequired && !publicDnsTlsHostModeAvailable
                    ? ["dns_tls_unavailable"]
                    : []
            ),
            ...(
                publicAuditRequired
                    ? (
                        publicAuditSinkAvailable
                            ? []
                            : ["audit_sink_unavailable"]
                    )
                    : ["audit_required_disabled"]
            ),
            ...(
                publicRateLimitProfileConfigured
                    ? []
                    : ["rate_limit_profile_unconfigured"]
            ),
            ...(
                publicRateLimitProfileConfigured && !publicRateLimitCheckerAvailable
                    ? ["rate_limit_checker_unavailable"]
                    : []
            ),
        ];
    })();
    const publicRuntimeReady = featureConfig.publicPreviewEnabled && publicDisabledReasons.length === 0;

    return {
        features: {
            localServices: {
                enabled: localServicesEnabled,
                inventory: {
                    // Inventory is a core gate (default-allow); dependency closure disables
                    // preview/public exposure when the server turns inventory off.
                    enabled: featureConfig.inventoryEnabled,
                },
                managed: {
                    enabled: featureConfig.managedEnabled,
                },
                launcher: {
                    // Launcher is default-allow and depends only on inventory (passive detection) + browser
                    // view targets (NOT managed lifecycle, NOT exposure-preview); it stays on in default deployments.
                    enabled: featureConfig.launcherEnabled,
                },
                actions: {
                    enabled: featureConfig.actionsEnabled,
                    terminate: {
                        enabled: featureConfig.actionsTerminateEnabled,
                    },
                },
                preview: {
                    enabled: featureConfig.previewEnabled,
                },
                publicPreview: {
                    enabled: publicRuntimeReady,
                },
            },
        },
        capabilities: {
            localServices: {
                preview: {
                    enabled: featureConfig.previewEnabled,
                    hostOriginAvailable: Boolean(featureConfig.previewHostOriginBaseDomain),
                    pathModeAvailable: featureConfig.previewEnabled,
                    pmsRelayReady: pmsPreviewReady,
                    pmsStreamingReady: pmsPreviewReady,
                    webSocketSupport: pmsPreviewReady,
                    streamingSseSupport: pmsPreviewReady,
                    tokenTtlMs: featureConfig.previewTokenTtlMs,
                    disabledReasons: pmsDisabledReasons,
                },
                publicPreview: {
                    enabled: publicRuntimeReady,
                    allowedModes: featureConfig.publicPolicy.allowedModes,
                    maxTtlMs: featureConfig.publicPolicy.maxTtlMs,
                    maxConcurrentExposures: featureConfig.publicPolicy.maxConcurrentExposures,
                    dnsTlsHostModeAvailable: publicDnsTlsHostModeAvailable,
                    webSocketSupport: publicRuntimeReady && pmsPreviewReady,
                    auditEnabled: publicAuditRequired && publicAuditSinkAvailable,
                    abuseControlsEnabled: publicRateLimitProfileConfigured && publicRateLimitCheckerAvailable,
                    rateLimitProfileIds: featureConfig.publicPolicy.rateLimitProfileIds,
                    disabledReasons: publicDisabledReasons,
                },
            },
        },
    };
}
