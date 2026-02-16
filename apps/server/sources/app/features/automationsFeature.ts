import type { FeaturesResponse } from "./types";
import { readAutomationsFeatureEnv } from "./catalog/readFeatureEnv";
import { isServerFeatureEnabledByBuildPolicy } from "./catalog/serverFeatureBuildPolicy";

export function resolveAutomationsFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "automations"> {
    const config = readAutomationsFeatureEnv(env);
    const buildEnabled = isServerFeatureEnabledByBuildPolicy("automations", env);
    const enabled = buildEnabled && config.enabled;
    const existingSessionTargetEnabled =
        enabled &&
        isServerFeatureEnabledByBuildPolicy("automations.existingSessionTarget", env) &&
        config.existingSessionTarget;
    return {
        automations: {
            enabled,
            existingSessionTarget: existingSessionTargetEnabled,
        },
    };
}
