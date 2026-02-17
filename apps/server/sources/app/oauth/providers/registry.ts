import type { FeaturesResponse } from "@/app/features/types";
import type { OAuthFlowProvider, OAuthProviderStatus } from "./types";
import type { AuthProviderId } from "@happier-dev/protocol";
import { resolveProviderModules } from "@/app/auth/providers/providerModules";

export type OAuthProviderId = AuthProviderId;

export type OAuthProviderStatusSchema = FeaturesResponse["capabilities"]["oauth"]["providers"][string];

export function resolveOAuthProviderRegistry(env: NodeJS.ProcessEnv): readonly OAuthFlowProvider[] {
    return Object.freeze(resolveProviderModules(env).flatMap((m) => (m.oauth ? [m.oauth] : [])));
}

export function resolveOAuthProviderStatuses(env: NodeJS.ProcessEnv): Record<string, OAuthProviderStatusSchema> {
    const out: Record<string, OAuthProviderStatusSchema> = {};
    for (const provider of resolveOAuthProviderRegistry(env)) {
        out[provider.id] = provider.resolveStatus(env) as OAuthProviderStatusSchema;
    }
    return out;
}

export function findOAuthProviderById(env: NodeJS.ProcessEnv, id: string): OAuthFlowProvider | null {
    const oauthProviderRegistry = resolveOAuthProviderRegistry(env);
    const normalized = id.toString().trim().toLowerCase();
    for (const provider of oauthProviderRegistry) {
        if (provider.id.toString().trim().toLowerCase() === normalized) return provider;
    }
    return null;
}

export type { OAuthFlowProvider, OAuthProviderStatus };
