import type { FeaturesResponse } from "./types";
import { readUpdatesFeatureEnv } from "./catalog/readFeatureEnv";
import { isServerFeatureEnabledByBuildPolicy } from "./catalog/serverFeatureBuildPolicy";

export function resolveUpdatesFeature(
    env: NodeJS.ProcessEnv,
): Pick<FeaturesResponse["features"], "updates"> {
    const featureEnv = readUpdatesFeatureEnv(env);
    const buildEnabled = isServerFeatureEnabledByBuildPolicy("updates.ota", env);

    return {
        updates: {
            ota: {
                enabled: buildEnabled && featureEnv.otaEnabled,
            },
        },
    };
}
