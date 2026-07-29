import type { FeaturesPayloadDelta } from "./types";
import { readPluginsFeatureEnv } from "./catalog/readFeatureEnv";

export function resolvePluginsFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readPluginsFeatureEnv(env);

    // The core plugin platform + UI projection gates are server-represented + default-allow: the
    // server can disable the plugin surface for its users. The plugin UI tiers (hostedWeb /
    // structuredMessages / reactNativeBundles) are ALSO server-represented +
    // default-ALLOW kill-switches (§4.1/§13.5.3): the server/build can disable a tier, but
    // per-plugin install/enable/trust/runtime derivation (5.1/5.2) governs actual render.
    // Dependency enforcement in resolveServerFeaturePayload cascades a parent off-state to the
    // children. The finer reactNativeBundles.devHotReload tier stays client + fail-closed (CLI/UI
    // local policy owns it), so it is not emitted here.
    return {
        features: {
            plugins: {
                enabled: config.enabled,
                ui: {
                    enabled: config.uiEnabled,
                    hostedWeb: { enabled: config.uiHostedWebEnabled },
                    structuredMessages: { enabled: config.uiStructuredMessagesEnabled },
                    reactNativeBundles: { enabled: config.uiReactNativeBundlesEnabled },
                },
            },
        },
    };
}
