import * as oidcClient from "openid-client";

import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";

type CachedDiscovery = Readonly<{
    config: oidcClient.Configuration;
    expiresAtMs: number;
}>;

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, CachedDiscovery>();

function cacheKey(params: { issuer: string; clientId: string }): string {
    return `${params.issuer}|${params.clientId}`;
}

export async function discoverOidcConfiguration(instance: OidcAuthProviderInstanceConfig): Promise<oidcClient.Configuration> {
    const key = cacheKey({ issuer: instance.issuer, clientId: instance.clientId });
    const cached = discoveryCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAtMs > now) return cached.config;

    let issuer: URL;
    try {
        issuer = new URL(instance.issuer);
    } catch {
        throw new Error(`Invalid OIDC issuer URL: ${instance.issuer}`);
    }
    const options: any = { timeout: instance.httpTimeoutSeconds };
    if (issuer.protocol === "http:") {
        options.execute = [oidcClient.allowInsecureRequests] as Array<(c: oidcClient.Configuration) => void>;
    }
    const config = await oidcClient.discovery(issuer, instance.clientId, instance.clientSecret, undefined, options);
    discoveryCache.set(key, { config, expiresAtMs: now + DISCOVERY_TTL_MS });
    return config;
}
