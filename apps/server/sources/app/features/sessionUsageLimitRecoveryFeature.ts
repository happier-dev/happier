import { readSessionUsageLimitRecoveryFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveSessionUsageLimitRecoveryFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readSessionUsageLimitRecoveryFeatureEnv(env);

    return {
        features: {
            sessions: {
                enabled: true,
                usageLimitRecovery: { enabled: featureConfig.enabled },
            },
        },
    };
}
