import type { IdentityProvider } from "./types";
import { resolveProviderModules } from "@/app/auth/providers/providerModules";

export function resolveIdentityProviderRegistry(env: NodeJS.ProcessEnv): readonly IdentityProvider[] {
    return Object.freeze(resolveProviderModules(env).flatMap((m) => (m.identity ? [m.identity] : [])));
}

export function findIdentityProviderById(env: NodeJS.ProcessEnv, id: string): IdentityProvider | null {
    const identityProviderRegistry = resolveIdentityProviderRegistry(env);
    const normalized = id.toString().trim().toLowerCase();
    for (const provider of identityProviderRegistry) {
        if (provider.id.toString().trim().toLowerCase() === normalized) return provider;
    }
    return null;
}
