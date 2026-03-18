import { readSessionHandoffFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveSessionHandoffFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readSessionHandoffFeatureEnv(env);

    return {
        features: {
            sessions: {
                enabled: true,
                handoff: {
                    enabled: featureConfig.handoffEnabled,
                },
            },
        },
    };
}
