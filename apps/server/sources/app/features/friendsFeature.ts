import type { FeaturesResponse } from "./types";
import { resolveFriendsPolicyFromEnv } from "@/app/social/friendsPolicy";
import { resolveOAuthProviderStatuses } from "@/app/oauth/providers/registry";
import { isServerFeatureEnabledByBuildPolicy } from "./catalog/serverFeatureBuildPolicy";

export function resolveFriendsFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "social"> {
    const friendsPolicy = resolveFriendsPolicyFromEnv(env);
    const oauthProviders = resolveOAuthProviderStatuses(env);
    const buildEnabled = isServerFeatureEnabledByBuildPolicy("social.friends", env);

    const requiredProviderId = friendsPolicy.requiredIdentityProviderId;
    const providerConfigured = requiredProviderId ? oauthProviders[requiredProviderId]?.configured === true : true;
    // Fail-closed: only advertise friends as enabled when there is an available identity path.
    // If username identity is disabled and the required provider isn't configured, clients should hide entry points.
    const enabled = buildEnabled && friendsPolicy.enabled && (friendsPolicy.allowUsername || providerConfigured);

    return {
        social: {
            friends: {
                enabled,
                allowUsername: friendsPolicy.allowUsername,
                requiredIdentityProviderId: requiredProviderId,
            },
        },
    };
}
