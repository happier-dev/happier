import type { FeaturesPayloadDelta } from "./types";
import { readProvidersFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveProvidersFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readProvidersFeatureEnv(env);

    return {
        capabilities: { providerBroker: { protocolVersions: [1, 2] } },
        features: {
            providers: {
                enabled: featureConfig.enabled,
                localDiscovery: {
                    enabled: featureConfig.localDiscoveryEnabled,
                },
                localModelManagement: {
                    enabled: featureConfig.localModelManagementEnabled,
                },
            },
        },
    };
}
