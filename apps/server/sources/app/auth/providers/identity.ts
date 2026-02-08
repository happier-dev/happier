import type { Context } from "@/context";
import { findIdentityProviderById } from "./identityProviders/registry";

export async function connectExternalIdentity(params: {
    providerId: string;
    ctx: Context;
    profile: unknown;
    accessToken: string;
    refreshToken?: string;
    preferredUsername?: string | null;
}): Promise<void> {
    const providerId = params.providerId.toString().trim().toLowerCase();
    const provider = findIdentityProviderById(process.env, providerId);
    if (!provider) throw new Error("unsupported-provider");
    return await provider.connect({
        ctx: params.ctx,
        profile: params.profile,
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        preferredUsername: params.preferredUsername,
    });
}

export async function disconnectExternalIdentity(params: { providerId: string; ctx: Context }): Promise<void> {
    const providerId = params.providerId.toString().trim().toLowerCase();
    const provider = findIdentityProviderById(process.env, providerId);
    if (!provider) throw new Error("unsupported-provider");
    return await provider.disconnect({ ctx: params.ctx });
}
