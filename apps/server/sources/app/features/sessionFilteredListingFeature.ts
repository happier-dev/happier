import type { FeaturesPayloadDelta } from './types';
import { readSessionFilteredListingFeatureEnv } from './catalog/readFeatureEnv';

/** The one server bit for structurally filtered Session listing; the env variable is the operator opt-out. */
export function resolveSessionFilteredListingFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    return {
        features: {
            sessions: {
                enabled: true,
                filteredListing: {
                    enabled: readSessionFilteredListingFeatureEnv(env).filteredListingEnabled,
                    projectSelectorVersion: 1,
                    membershipSelectorVersion: 1,
                },
            },
        },
    };
}
