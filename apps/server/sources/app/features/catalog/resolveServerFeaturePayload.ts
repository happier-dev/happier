import { featuresSchema, type FeaturesResponse } from '@/app/features/types';

import { serverFeatureRegistry, type ServerFeatureResolver } from './serverFeatureRegistry';

export function resolveServerFeaturePayload(
    env: NodeJS.ProcessEnv,
    resolvers: readonly ServerFeatureResolver[] = serverFeatureRegistry,
): FeaturesResponse {
    const merged: Record<string, unknown> = {};
    for (const resolver of resolvers) {
        Object.assign(merged, resolver(env));
    }

    const parsed = featuresSchema.safeParse({ features: merged });
    if (!parsed.success) {
        throw new Error(`Invalid /v1/features payload: ${parsed.error.message}`);
    }

    return parsed.data;
}
