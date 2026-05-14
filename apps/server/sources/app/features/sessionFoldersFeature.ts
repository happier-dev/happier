import { readSessionFoldersFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveSessionFoldersFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const featureConfig = readSessionFoldersFeatureEnv(env);

    return {
        features: {
            sessions: {
                enabled: true,
                folders: { enabled: featureConfig.foldersEnabled },
            },
        },
    };
}
