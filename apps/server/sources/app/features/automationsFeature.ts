import type { FeaturesResponse } from "./types";
import { readAutomationsFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveAutomationsFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "automations"> {
    const config = readAutomationsFeatureEnv(env);
    return {
        automations: {
            enabled: config.enabled,
            existingSessionTarget: config.existingSessionTarget,
        },
    };
}
