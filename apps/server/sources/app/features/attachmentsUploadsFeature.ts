import type { FeaturesPayloadDelta } from "./types";
import { readAttachmentsUploadsFeatureEnv } from "./catalog/readFeatureEnv";

export function resolveAttachmentsUploadsFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const config = readAttachmentsUploadsFeatureEnv(env);

    return {
        features: {
            attachments: {
                uploads: { enabled: config.enabled },
            },
        },
    };
}

