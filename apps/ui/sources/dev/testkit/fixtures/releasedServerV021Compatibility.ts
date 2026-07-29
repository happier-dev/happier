import {
    FeaturesResponseSchema,
    type FeaturesResponse,
} from '@happier-dev/protocol';

/**
 * Relevant `/v1/features` bytes from immutable server-v0.2.1 commit
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2.
 *
 * Keep this as historical JSON. In particular, do not rebuild it from the
 * current feature fixture builder or current inferred feature types.
 */
export const RELEASED_SERVER_V0_2_1_FEATURES_JSON = {
    features: {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
    },
    capabilities: {},
} as const;

export function parseReleasedServerV021Features(): FeaturesResponse {
    return FeaturesResponseSchema.parse(RELEASED_SERVER_V0_2_1_FEATURES_JSON);
}
