import type { FeaturesResponse } from "./types";
import { readConnectedServicesFeatureEnv } from "./catalog/readFeatureEnv";
import { isServerFeatureEnabledByBuildPolicy } from "./catalog/serverFeatureBuildPolicy";

export function resolveConnectedServicesFeature(
    env: NodeJS.ProcessEnv,
): Pick<FeaturesResponse["features"], "connectedServices"> {
    const featureEnv = readConnectedServicesFeatureEnv(env);
    const buildEnabled = isServerFeatureEnabledByBuildPolicy("connected.services", env);
    const enabled = buildEnabled && featureEnv.enabled;
    const quotasEnabled =
        enabled &&
        isServerFeatureEnabledByBuildPolicy("connected.services.quotas", env) &&
        featureEnv.quotasEnabled;

    return {
        connectedServices: {
            enabled,
            webOauthProxyEnabled: enabled,
            quotas: { enabled: quotasEnabled },
        },
    };
}
