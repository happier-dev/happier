import { parseBooleanEnv } from "@/config/env";

export type FriendsPolicy = Readonly<{
    enabled: boolean;
    allowUsername: boolean;
    requiredIdentityProviderId: string | null;
}>;

export function resolveFriendsPolicyFromEnv(env: NodeJS.ProcessEnv): FriendsPolicy {
    const enabled = parseBooleanEnv(env.FRIENDS_ENABLED, true);
    const allowUsername = parseBooleanEnv(env.FRIENDS_ALLOW_USERNAME, false);
    const requiredIdentityProviderIdRaw =
        typeof env.FRIENDS_IDENTITY_PROVIDER === "string" && env.FRIENDS_IDENTITY_PROVIDER.trim()
            ? env.FRIENDS_IDENTITY_PROVIDER.trim()
            : "github";
    const requiredIdentityProviderId = allowUsername ? null : requiredIdentityProviderIdRaw.toLowerCase();
    return Object.freeze({ enabled, allowUsername, requiredIdentityProviderId });
}
