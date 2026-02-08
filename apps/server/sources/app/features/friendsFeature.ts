import type { FeaturesResponse } from "./types";
import { resolveFriendsPolicyFromEnv } from "@/app/social/friendsPolicy";
import { resolveOAuthProviderStatuses } from "@/app/oauth/providers/registry";

export function resolveFriendsFeature(env: NodeJS.ProcessEnv): Pick<FeaturesResponse["features"], "social"> {
    const friendsPolicy = resolveFriendsPolicyFromEnv(env);
    const oauthProviders = resolveOAuthProviderStatuses(env);

    const requiredProviderId = friendsPolicy.requiredIdentityProviderId;
    const providerConfigured = requiredProviderId ? oauthProviders[requiredProviderId]?.configured === true : true;
    const enabled = friendsPolicy.enabled && (friendsPolicy.allowUsername || providerConfigured);

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
