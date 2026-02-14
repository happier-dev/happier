import { readSocialFriendsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

export type FriendsPolicy = Readonly<{
    enabled: boolean;
    allowUsername: boolean;
    requiredIdentityProviderId: string | null;
}>;

export function resolveFriendsPolicyFromEnv(env: NodeJS.ProcessEnv): FriendsPolicy {
    const featureEnv = readSocialFriendsFeatureEnv(env);
    const enabled = featureEnv.enabled;
    const allowUsername = featureEnv.allowUsername;
    const requiredIdentityProviderIdRaw = featureEnv.identityProvider;
    const requiredIdentityProviderId = allowUsername ? null : requiredIdentityProviderIdRaw.toLowerCase();
    return Object.freeze({ enabled, allowUsername, requiredIdentityProviderId });
}
