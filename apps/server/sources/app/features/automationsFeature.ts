import type { FeaturesPayloadDelta } from "./types";
import { readAutomationsFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveAutomationsFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readAutomationsFeatureEnv(env);
    const enabled = config.enabled;
    const existingSessionTargetEnabled = config.existingSessionTarget;
    return {
        features: {
            automations: {
                enabled,
                existingSessionTarget: { enabled: existingSessionTargetEnabled },
            },
        },
    };
}
