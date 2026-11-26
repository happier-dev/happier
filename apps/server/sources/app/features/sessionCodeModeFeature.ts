import { readSessionCodeModeFeatureEnv } from './catalog/readFeatureEnv';
import type { FeaturesPayloadDelta } from './types';

export function resolveSessionCodeModeFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const { sessionsCodeModeEnabled } = readSessionCodeModeFeatureEnv(env);
    return {
        features: {
            sessions: { enabled: true, codeMode: { enabled: sessionsCodeModeEnabled } },
        },
    };
}
