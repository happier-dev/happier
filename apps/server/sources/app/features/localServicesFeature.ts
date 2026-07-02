import type { FeaturesPayloadDelta } from "./types";
import {
    readLocalServicesFeatureEnv,
    readMachineTunnelFeatureEnv,
} from "./catalog/readFeatureEnv";

export function resolveLocalServicesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readLocalServicesFeatureEnv(env);
    const tunnelConfig = readMachineTunnelFeatureEnv(env);
    const localServicesEnabled = featureConfig.inventoryEnabled || featureConfig.previewEnabled;
    const pmsPreviewReady = featureConfig.previewEnabled
        && tunnelConfig.serverRoutedEnabled
        && tunnelConfig.allowedPorts.length > 0;
    const pmsDisabledReasons = (() => {
        if (!featureConfig.previewEnabled) return ["disabled_by_server_policy"];
        if (!tunnelConfig.serverRoutedEnabled) return ["pms_server_relay_disabled"];
        if (tunnelConfig.allowedPorts.length === 0) return ["pms_allowed_ports_empty"];
        return [];
    })();

    return {
        features: {
            localServices: {
                enabled: localServicesEnabled,
                inventory: {
                    enabled: featureConfig.inventoryEnabled || featureConfig.previewEnabled,
                },
                preview: {
                    enabled: featureConfig.previewEnabled,
                },
                publicPreview: {
                    enabled: featureConfig.publicPreviewEnabled,
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
                    enabled: featureConfig.publicPreviewEnabled,
                    allowedModes: featureConfig.publicPolicy.allowedModes,
                    maxTtlMs: featureConfig.publicPolicy.maxTtlMs,
                    maxConcurrentExposures: featureConfig.publicPolicy.maxConcurrentExposures,
                    dnsTlsHostModeAvailable: Boolean(featureConfig.previewHostOriginBaseDomain),
                    auditEnabled: featureConfig.publicPolicy.auditRequired,
                    abuseControlsEnabled: false,
                    rateLimitProfileIds: featureConfig.publicPolicy.rateLimitProfileIds,
                    disabledReasons: featureConfig.publicPreviewEnabled
                        ? pmsDisabledReasons
                        : ["disabled_by_server_policy"],
                },
            },
        },
    };
}
