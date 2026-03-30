import type { FeaturesPayloadDelta } from "./types";
import { readChannelBridgesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveChannelBridgesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureEnv = readChannelBridgesFeatureEnv(env);

    return {
        features: {
            channelBridges: {
                enabled: featureEnv.enabled,
                telegram: {
                    enabled: featureEnv.telegramEnabled,
                },
            },
        },
    };
}
