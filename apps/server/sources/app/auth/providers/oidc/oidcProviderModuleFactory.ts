import type { ProviderModule } from "@/app/auth/providers/providerModules";
import type { AuthProviderResolver } from "@/app/auth/providers/types";
import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";

import { createOidcOAuthProvider } from "@/app/oauth/providers/oidc/oidcOAuthProvider";
import { createOidcIdentityProvider } from "@/app/auth/providers/oidc/oidcIdentityProvider";

function createOidcAuthProviderResolver(instance: OidcAuthProviderInstanceConfig): AuthProviderResolver {
    return Object.freeze({
        id: instance.id,
        resolveFeatures: ({ policy }) => {
            const usersAllowlist = instance.allow.usersAllowlist.length > 0;
            const orgsAllowlist =
                instance.allow.emailDomains.length > 0 ||
                instance.allow.groupsAny.length > 0 ||
                instance.allow.groupsAll.length > 0;
            const orgMatch = instance.allow.groupsAll.length > 0 ? "all" : "any";
            const source = instance.storeRefreshToken ? "oidc_refresh_token" : "oidc_claims";
            return {
                enabled: true,
                configured: true,
                ui: {
                    displayName: instance.displayName,
                    iconHint: instance.ui.iconHint ?? "oidc",
                    connectButtonColor: instance.ui.buttonColor,
                    supportsProfileBadge: false,
                },
                restrictions: {
                    usersAllowlist,
                    orgsAllowlist,
                    orgMatch,
                },
                offboarding: {
                    enabled: policy.offboarding.enabled,
                    intervalSeconds: policy.offboarding.intervalSeconds,
                    mode: policy.offboarding.mode,
                    source,
                },
            };
        },
        requiresOAuth: true,
        isConfigured: () => true,
    });
}

export function createOidcProviderModule(instance: OidcAuthProviderInstanceConfig): ProviderModule {
    return Object.freeze({
        id: instance.id,
        oauth: createOidcOAuthProvider(instance),
        identity: createOidcIdentityProvider(instance),
        auth: createOidcAuthProviderResolver(instance),
    }) satisfies ProviderModule;
}
