import { readSessionDraftsFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveSessionDraftsFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readSessionDraftsFeatureEnv(env);

    return {
        features: {
            sessions: {
                enabled: true,
                drafts: { enabled: featureConfig.draftsEnabled },
            },
        },
    };
}
