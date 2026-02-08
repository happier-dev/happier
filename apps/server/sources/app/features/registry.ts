import { type FeaturesResponse, featuresSchema } from "./types";
import { resolveSharingFeature } from "./sharingFeature";
import { resolveVoiceFeature } from "./voiceFeature";
import { resolveFriendsFeature } from "./friendsFeature";
import { resolveOAuthFeature } from "./oauthFeature";
import { resolveAuthFeature } from "./authFeature";

export type FeatureResolver = (env: NodeJS.ProcessEnv) => Partial<FeaturesResponse["features"]>;

export const featureRegistry: readonly FeatureResolver[] = Object.freeze([
    (_env) => resolveSharingFeature(),
    (env) => resolveVoiceFeature(env),
    (env) => resolveFriendsFeature(env),
    (env) => resolveOAuthFeature(env),
    (env) => resolveAuthFeature(env),
]);

export function resolveFeaturesFromEnv(env: NodeJS.ProcessEnv, resolvers: readonly FeatureResolver[] = featureRegistry): FeaturesResponse {
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
