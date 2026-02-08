import { resolveGitHubOAuthConfigFromEnv } from "@/app/oauth/providers/githubOAuthConfig";
import { githubOAuthProvider } from "@/app/oauth/providers/github";

import { connectGitHubIdentity, disconnectGitHubIdentity } from "@/app/auth/providers/github/identity";
import { enforceGitHubLoginEligibility } from "@/app/auth/providers/github/loginEligibility";
import { extractGitHubSocialProfile } from "@/app/auth/providers/github/socialProfile";
import { resolveGitHubAuthRestrictionsFromEnv } from "@/app/auth/providers/github/restrictions";
import { extractGitHubLinkedProvider } from "@/app/auth/providers/github/linkedProvider";
import { extractGitHubProfileBadge } from "@/app/auth/providers/github/profileBadge";

import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { AuthProviderResolver } from "@/app/auth/providers/types";
import type { ProviderModule } from "@/app/auth/providers/providerModules";

const githubIdentityProvider: IdentityProvider = Object.freeze({
    id: "github",
    connect: async (params) =>
        connectGitHubIdentity({
            ctx: params.ctx,
            profile: params.profile,
            accessToken: params.accessToken,
            preferredUsername: params.preferredUsername,
    }),
    disconnect: async (params) => disconnectGitHubIdentity(params.ctx),
    enforceLoginEligibility: async (params) =>
        enforceGitHubLoginEligibility({
            accountId: params.accountId,
            env: params.env,
            policy: params.policy,
            now: params.now,
        }),
    extractSocialProfile: (params) => extractGitHubSocialProfile({ profile: params.profile }),
    extractLinkedProvider: (params) =>
        extractGitHubLinkedProvider({ profile: params.profile, providerLogin: params.providerLogin }),
    extractProfileBadge: (params) =>
        extractGitHubProfileBadge({ profile: params.profile, providerLogin: params.providerLogin }),
});

const githubAuthProviderResolver: AuthProviderResolver = Object.freeze({
    id: "github",
    resolveFeatures: ({ env, policy }) => {
        const githubOAuth = resolveGitHubOAuthConfigFromEnv(env);
        const restrictions = resolveGitHubAuthRestrictionsFromEnv(env);
        return {
            enabled: true,
            configured: githubOAuth.status.configured,
            ui: {
                displayName: "GitHub",
                iconHint: "github",
                connectButtonColor: "#24292F",
                supportsProfileBadge: true,
                badgeIconName: "github",
            },
            restrictions: {
                usersAllowlist: restrictions.allowedUsers.length > 0,
                orgsAllowlist: restrictions.allowedOrgs.length > 0,
                orgMatch: restrictions.orgMatch,
            },
            offboarding: {
                enabled: policy.offboarding.enabled,
                intervalSeconds: policy.offboarding.intervalSeconds,
                mode: policy.offboarding.mode,
                source: restrictions.orgMembershipSource,
            },
        };
    },
    requiresOAuth: true,
    isConfigured: (env) => resolveGitHubOAuthConfigFromEnv(env).status.configured,
});

export const githubProviderModule: ProviderModule = Object.freeze({
    id: "github",
    oauth: githubOAuthProvider,
    identity: githubIdentityProvider,
    auth: githubAuthProviderResolver,
});
