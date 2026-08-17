import type { FeaturesPayloadDelta } from "./types";
import {
    PluginDataCollectionsCapabilitiesSchema,
    PluginUiArtifactHostingCapabilityV1Schema,
    type PluginDataCollectionsCapabilities,
    type PluginUiArtifactHostingCapabilityV1,
} from "@happier-dev/protocol";

import { readPluginsFeatureEnv, type PluginsFeatureEnv } from "./catalog/readFeatureEnv";

function resolvePluginUiArtifactHostingCapabilityFromConfig(
    config: PluginsFeatureEnv,
): PluginUiArtifactHostingCapabilityV1 {
    const maxArtifactBytes = config.uiArtifactHostingMaxArtifactBytes;
    const maxAccountBytes = config.uiArtifactHostingMaxAccountBytes;
    if (
        !config.uiArtifactHostingEnabled
        || maxArtifactBytes === undefined
        || maxAccountBytes === undefined
        || maxAccountBytes < maxArtifactBytes
    ) {
        return { enabled: false };
    }

    return PluginUiArtifactHostingCapabilityV1Schema.parse({
        enabled: true,
        maxArtifactBytes,
        maxAccountBytes,
    });
}

function resolvePluginDataCollectionsCapabilityFromConfig(
    config: PluginsFeatureEnv,
): PluginDataCollectionsCapabilities {
    return PluginDataCollectionsCapabilitiesSchema.parse(config.collectionLimits);
}

/**
 * Infrastructure capability only: it deliberately does not decide plugin trust,
 * installation, renderer admission, or whether a particular client can adopt a slot.
 */
export function resolvePluginUiArtifactHostingCapability(
    env: NodeJS.ProcessEnv,
): PluginUiArtifactHostingCapabilityV1 {
    return resolvePluginUiArtifactHostingCapabilityFromConfig(readPluginsFeatureEnv(env));
}

export function resolvePluginsFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readPluginsFeatureEnv(env);

    // The core plugin platform + UI projection gates are server-represented + default-allow: the
    // server can disable the plugin surface for its users. The supported plugin UI tiers (hostedWeb /
    // reactNativeBundles) are ALSO server-represented +
    // default-ALLOW kill-switches (§4.1/§13.5.3): the server/build can disable a tier, but
    // per-plugin install/enable/trust/runtime derivation (5.1/5.2) governs actual render.
    // Dependency enforcement in resolveServerFeaturePayload cascades a parent off-state to the
    // children. The finer reactNativeBundles.devHotReload tier stays client + fail-closed (CLI/UI
    // local policy owns it), so it is not emitted here.
    return {
        features: {
            plugins: {
                enabled: config.enabled,
                webhooks: { enabled: config.webhooksEnabled },
                ui: {
                    enabled: config.uiEnabled,
                    hostedWeb: { enabled: config.uiHostedWebEnabled },
                    reactNativeBundles: { enabled: config.uiReactNativeBundlesEnabled },
                },
            },
        },
        capabilities: {
            pluginDataCollections: resolvePluginDataCollectionsCapabilityFromConfig(config),
            plugins: {
                uiArtifactHosting: resolvePluginUiArtifactHostingCapabilityFromConfig(config),
            },
        },
    };
}
