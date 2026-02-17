import type { FeaturesPayloadDelta } from "./types";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveConnectedServicesFeature(
    env: NodeJS.ProcessEnv,
): FeaturesPayloadDelta {
    const featureEnv = readConnectedServicesFeatureEnv(env);
    const enabled = featureEnv.enabled;
    const quotasEnabled = featureEnv.quotasEnabled;

    return {
        features: {
            connectedServices: {
                enabled,
                quotas: { enabled: quotasEnabled },
            },
        },
    };
}
