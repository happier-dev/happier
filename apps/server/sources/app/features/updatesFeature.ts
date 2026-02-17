import type { FeaturesPayloadDelta } from "./types";
import { readUpdatesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveUpdatesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const featureEnv = readUpdatesFeatureEnv(env);

    return {
        features: {
            updates: {
                ota: {
                    enabled: featureEnv.otaEnabled,
                },
            },
        },
    };
}
