import type { FeaturesPayloadDelta } from "./types";

export function resolveSharingFeature(): FeaturesPayloadDelta {
    return {
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
            },
        },
    };
}
