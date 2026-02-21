import { type Fastify } from "../../types";
import { registerTerminalAuthRequestRoutes } from "./registerTerminalAuthRequestRoutes";
import { registerAccountAuthRoutes } from "./registerAccountAuthRoutes";
import { resolveTerminalAuthRequestPolicyFromEnv } from "./terminalAuthRequestPolicy";
import { readAuthFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveAuthFeature } from "@/app/features/authFeature";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";

function hasAnyViableNonKeyChallengeAuthMethod(env: NodeJS.ProcessEnv): boolean {
    const feature = resolveAuthFeature(env);
    const methods = feature.capabilities?.auth?.methods ?? [];
    return methods.some((m: any) => {
        const id = String(m?.id ?? "").trim().toLowerCase();
        if (!id || id === "key_challenge") return false;
        const actions = Array.isArray(m?.actions) ? m.actions : [];
        return actions.some((a: any) => a?.enabled === true && (a?.id === "login" || a?.id === "provision"));
    });
}

export function authRoutes(app: Fastify): void {
    const terminalAuthPolicy = resolveTerminalAuthRequestPolicyFromEnv(process.env);
    const isTerminalAuthExpired = (createdAt: Date): boolean => {
        const ageMs = Date.now() - createdAt.getTime();
        return ageMs > terminalAuthPolicy.ttlMs;
    };

    const authFeatureEnv = readAuthFeatureEnv(process.env);
    if (!authFeatureEnv.loginKeyChallengeEnabled) {
        if (!hasAnyViableNonKeyChallengeAuthMethod(process.env)) {
            throw new Error(
                "No login methods are available: HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED=0, no viable AUTH_SIGNUP_PROVIDERS are configured, and no other login providers are enabled.",
            );
        }
    }
    const authMethodRegistry = resolveAuthMethodRegistry(process.env);
    for (const method of authMethodRegistry) {
        method.registerRoutes(app);
    }
    registerTerminalAuthRequestRoutes(app, { terminalAuthPolicy, isTerminalAuthExpired });
    registerAccountAuthRoutes(app);
}
