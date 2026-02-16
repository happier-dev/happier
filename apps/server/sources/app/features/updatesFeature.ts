import type { FeaturesResponse } from "./types";
import { readUpdatesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveUpdatesFeature(
    env: NodeJS.ProcessEnv,
): Pick<FeaturesResponse["features"], "updates"> {
    const featureEnv = readUpdatesFeatureEnv(env);

    return {
        updates: {
            ota: {
                enabled: featureEnv.otaEnabled,
            },
        },
    };
}

