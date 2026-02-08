import type { AuthProviderResolver } from "@/app/auth/providers/types";
import { resolveProviderModulesResult } from "@/app/auth/providers/providerModules";

export type { AuthProviderResolver, AuthProviderFeatures } from "@/app/auth/providers/types";

export function resolveAuthProviderRegistry(env: NodeJS.ProcessEnv): readonly AuthProviderResolver[] {
    return Object.freeze(resolveProviderModulesResult(env).modules.flatMap((m) => (m.auth ? [m.auth] : [])));
}

export function resolveAuthProviderRegistryResult(env: NodeJS.ProcessEnv): Readonly<{
    providers: readonly AuthProviderResolver[];
    errors: readonly string[];
}> {
    const result = resolveProviderModulesResult(env);
    return Object.freeze({
        providers: Object.freeze(result.modules.flatMap((m) => (m.auth ? [m.auth] : []))),
        errors: result.errors,
    });
}

export function findAuthProviderById(env: NodeJS.ProcessEnv, id: string): AuthProviderResolver | null {
    const authProviderRegistry = resolveAuthProviderRegistry(env);
    const normalized = id.toString().trim().toLowerCase();
    for (const provider of authProviderRegistry) {
        if (provider.id.toString().trim().toLowerCase() === normalized) return provider;
    }
    return null;
}
