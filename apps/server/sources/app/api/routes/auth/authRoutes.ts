import { type Fastify } from "../../types";
import { registerKeyChallengeAuthRoute } from "./registerKeyChallengeAuthRoute";
import { registerTerminalAuthRequestRoutes } from "./registerTerminalAuthRequestRoutes";
import { registerAccountAuthRoutes } from "./registerAccountAuthRoutes";
import { resolveTerminalAuthRequestPolicyFromEnv } from "./terminalAuthRequestPolicy";
import { readAuthFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { resolveAuthProviderRegistryResult } from "@/app/auth/providers/registry";

function resolveViableExternalSignupProvidersFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
    const policy = resolveAuthPolicyFromEnv(env);
    const registry = resolveAuthProviderRegistryResult(env);
    const providers = registry.providers;

    return Object.freeze(
        policy.signupProviders.filter((providerId) => {
            const resolver = providers.find((p) => p.id === providerId);
            if (!resolver) return false;
            if (!resolver.requiresOAuth) return true;
            return resolver.isConfigured(env);
        }),
    );
}

export function authRoutes(app: Fastify): void {
    const terminalAuthPolicy = resolveTerminalAuthRequestPolicyFromEnv(process.env);
    const isTerminalAuthExpired = (createdAt: Date): boolean => {
        const ageMs = Date.now() - createdAt.getTime();
        return ageMs > terminalAuthPolicy.ttlMs;
    };

    const authFeatureEnv = readAuthFeatureEnv(process.env);
    if (!authFeatureEnv.loginKeyChallengeEnabled) {
        const viableExternalSignupProviders = resolveViableExternalSignupProvidersFromEnv(process.env);
        if (viableExternalSignupProviders.length === 0) {
            throw new Error(
                "No login methods are available: HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED=0 and no viable AUTH_SIGNUP_PROVIDERS are configured.",
            );
        }
    }
    if (authFeatureEnv.loginKeyChallengeEnabled) {
        registerKeyChallengeAuthRoute(app);
    }
    registerTerminalAuthRequestRoutes(app, { terminalAuthPolicy, isTerminalAuthExpired });
    registerAccountAuthRoutes(app);
}
