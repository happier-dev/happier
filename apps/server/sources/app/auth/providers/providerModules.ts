import type { AuthProviderId } from "@happier-dev/protocol";

import type { OAuthFlowProvider } from "@/app/oauth/providers/types";
import type { IdentityProvider } from "@/app/auth/providers/identityProviders/types";
import type { AuthProviderResolver } from "@/app/auth/providers/types";

import { githubProviderModule } from "@/app/auth/providers/github/providerModule";
import { resolveAuthProviderInstancesFromEnv } from "@/app/auth/providers/oidc/oidcProviderConfig";
import { createOidcProviderModule } from "@/app/auth/providers/oidc/oidcProviderModuleFactory";

export type ProviderModule = Readonly<{
    id: AuthProviderId;
    oauth?: OAuthFlowProvider;
    identity?: IdentityProvider;
    auth?: AuthProviderResolver;
}>;

const staticProviderModules: readonly ProviderModule[] = Object.freeze([
    githubProviderModule,
]);

export type ResolveProviderModulesResult = Readonly<{
    modules: readonly ProviderModule[];
    errors: readonly string[];
}>;

export function resolveProviderModulesResult(env: NodeJS.ProcessEnv): ResolveProviderModulesResult {
    const oidc = resolveAuthProviderInstancesFromEnv(env);
    if (oidc.errors.length > 0) {
        return Object.freeze({ modules: staticProviderModules, errors: Object.freeze(oidc.errors) });
    }

    const oidcModules: ProviderModule[] = oidc.instances.map((instance) => createOidcProviderModule(instance));

    return Object.freeze({ modules: Object.freeze([...staticProviderModules, ...oidcModules]), errors: Object.freeze([]) });
}

export function resolveProviderModules(env: NodeJS.ProcessEnv): readonly ProviderModule[] {
    return resolveProviderModulesResult(env).modules;
}
