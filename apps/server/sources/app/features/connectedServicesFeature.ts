import type { FeaturesResponse } from "./types";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveConnectedServicesFeature(
    env: NodeJS.ProcessEnv,
): Pick<FeaturesResponse["features"], "connectedServices"> {
    const featureEnv = readConnectedServicesFeatureEnv(env);
    const enabled = featureEnv.enabled;
    const quotasEnabled = enabled && featureEnv.quotasEnabled;

    return {
        connectedServices: {
            enabled,
            webOauthProxyEnabled: enabled,
            quotas: { enabled: quotasEnabled },
        },
    };
}
