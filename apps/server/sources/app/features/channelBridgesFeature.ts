import type { FeaturesPayloadDelta } from "./types";

import { readChannelBridgesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveChannelBridgesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureEnv = readChannelBridgesFeatureEnv(env);

    const enabled = featureEnv.enabled;
    const telegramEnabled = enabled && featureEnv.telegramEnabled;

    return {
        features: {
            channelBridges: {
                enabled,
                telegram: { enabled: telegramEnabled },
            },
        },
    };
}

