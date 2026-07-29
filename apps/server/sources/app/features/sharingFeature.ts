import type { FeaturesPayloadDelta } from "./types";

export function resolveSharingFeature(
    _env: NodeJS.ProcessEnv = {},
): FeaturesPayloadDelta {
    return {
        features: {
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: true },
                pendingDeliveryState: { enabled: true },
            },
        },
        capabilities: {
            sharing: {
                pendingQueueV2: {
                    deliveryState: true,
                    deliveryBlockedReason: true,
                },
            },
        },
    };
}
