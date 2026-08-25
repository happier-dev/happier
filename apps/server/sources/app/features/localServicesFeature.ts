import type { FeaturesPayloadDelta } from "./types";
import {
    readLocalServicesFeatureEnv,
    readMachineTunnelFeatureEnv,
    readPeerMediationFeatureEnv,
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

export function resolveLocalServicesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readLocalServicesFeatureEnv(env);
    const tunnelConfig = readMachineTunnelFeatureEnv(env);
    // Route-grant signing is the master switch for the server-relayed tunnel
    // (`docs/peer-mediation.md` §2.1): without it `createLocalServicePreviewTunnelOpener` throws
    // `grant_signing_unavailable` on every request, so a relay advertised as ready would be a
    // readiness bit that cannot fail.
    const peerMediationConfig = readPeerMediationFeatureEnv(env);
    // The core local-services product is server-represented + default-allow. Dependency
    // enforcement in resolveServerFeaturePayload cascades the parent off-state to children and
    // gates launcher behind preview, so emit the configured core gates directly.
    const localServicesEnabled = featureConfig.enabled;
    const pmsPreviewReady = featureConfig.previewEnabled
        && tunnelConfig.serverRoutedEnabled
        && tunnelConfig.allowedPorts.length > 0
        && peerMediationConfig.substrateEnabled;
    const pmsDisabledReasons = (() => {
        if (!featureConfig.previewEnabled) return ["disabled_by_server_policy"];
        if (!tunnelConfig.serverRoutedEnabled) return ["pms_server_relay_disabled"];
        if (tunnelConfig.allowedPorts.length === 0) return ["pms_allowed_ports_empty"];
        // Same code `resolvePeerMediationFeature` emits for the same unmet prerequisite; one
        // vocabulary for one fact.
        if (!peerMediationConfig.substrateEnabled) return ["peer_mediation_grant_signing_unavailable"];
        return [];
    })();
    const publicDnsTlsHostModeAvailable = Boolean(featureConfig.previewHostOriginBaseDomain)
        && isHttpsUrl(resolvePublicBaseUrl(env));
    const publicAllowedModesConfigured = featureConfig.publicPolicy.allowedModes.length > 0;
    const publicMaxTtlConfigured = typeof featureConfig.publicPolicy.maxTtlMs === "number";
    const publicAuditSinkAvailable = featureConfig.publicAuditDependency.kind !== "none";
    const publicRateLimitProfileConfigured = featureConfig.publicPolicy.rateLimitProfileIds.length > 0;
    // OE-4: the former `hasProductionReadyPublicRateLimitChecker` helper computed exactly this.
    // Its NODE_ENV and `fixed_window` branches sat behind an unconditional `publicPreviewOptIn`
    // short-circuit that the single call site always satisfied when the gate could observe it.
    // V1 self-hosted relays are a single process, so the in-memory `fixed_window` limiter IS the
    // shared limiter; a distributed limiter for multi-replica relays remains a deferred hardening.
    const publicRateLimitCheckerAvailable = featureConfig.publicRateLimitDependency.kind !== "none";
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
                // S-3: a public exposure is minted on its own isolated origin, so host-mode DNS/TLS
                // is now a hard prerequisite rather than one conditional on `dnsTlsRequired`.
                // Without it `createExposure` refuses with `public_origin_unavailable`.
                publicDnsTlsHostModeAvailable
                    ? []
                    : ["dns_tls_unavailable"]
            ),
            ...(
                publicAuditSinkAvailable
                    ? []
                    : ["audit_sink_unavailable"]
            ),
            ...(
                publicRateLimitProfileConfigured
                    ? []
                    : ["rate_limit_profile_unconfigured"]
            ),
            ...(
                // S-5 / INV-1: abuse control is the one dependency that used to fail open. A
                // checker is now required unconditionally, matching the runtime's own refusal.
                publicRateLimitCheckerAvailable
                    ? []
                    : ["rate_limit_checker_unavailable"]
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
                    auditEnabled: publicAuditSinkAvailable,
                    abuseControlsEnabled: publicRateLimitProfileConfigured && publicRateLimitCheckerAvailable,
                    rateLimitProfileIds: featureConfig.publicPolicy.rateLimitProfileIds,
                    disabledReasons: publicDisabledReasons,
                },
            },
        },
    };
}
