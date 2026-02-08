import type { FeaturesResponse } from "./types";

export function resolveSharingFeature(): Pick<FeaturesResponse["features"], "sharing"> {
    return {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
    };
}

