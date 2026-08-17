import { readSessionAgentSwitchingFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveSessionAgentSwitchingFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readSessionAgentSwitchingFeatureEnv(env);

    return {
        features: {
            sessions: {
                enabled: true,
                agentSwitching: { enabled: featureConfig.agentSwitchingEnabled },
            },
        },
    };
}
