import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/features/payload/responseLimits';
import { FeaturesResponseSchema, HomeHostFactSchema, type FeaturesResponse as ServerFeatures, type HomeHostFact } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { decodeBoundedJsonResponse } from './decodeBoundedJsonResponse';

export const SERVER_FEATURES_RESPONSE_MAX_UTF8_BYTES = FEATURES_RESPONSE_MAX_UTF8_BYTES_V1;

export function parseServerFeatures(raw: unknown): ServerFeatures | null {
    const parsed = FeaturesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** The authenticated feature projection is the only Home host source. */
export function readHomeHostFact(features: ServerFeatures | null | undefined): HomeHostFact {
    const parsed = HomeHostFactSchema.safeParse(features?.homeHostFact);
    return parsed.success ? parsed.data : { kind: 'unknown' };
}

/**
 * The single public/authenticated feature-response decoder. It charges bytes
 * before UTF-8 decoding or JSON parsing and does not trust Content-Length.
 */
export async function decodeServerFeaturesResponse(response: Response): Promise<ServerFeatures | null> {
    const raw = await decodeBoundedJsonResponse(response, SERVER_FEATURES_RESPONSE_MAX_UTF8_BYTES);
    return raw === null ? null : parseServerFeatures(raw);
}
