import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { HAPPIER_HOSTED_WEBAPP_URL_V1 } from '@happier-dev/protocol/server/urls/hostedWebappUrl';

import { readHomeConfigValueSource } from "@/app/home/settings/homeConfigProvenance";

import { resolveUiConfig } from "../api/uiConfig";

/** Last resort when neither `HAPPIER_WEBAPP_URL` nor a bundled UI at the public address applies. */
export const DEFAULT_WEBAPP_URL = HAPPIER_HOSTED_WEBAPP_URL_V1;

export function normalizeHttpUrl(raw: string): string | null {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
}

function appendUiPrefix(baseUrl: string, prefix: string): string {
    const normalizedBaseUrl = normalizeHttpUrl(baseUrl);
    if (!normalizedBaseUrl) return baseUrl;
    const parsed = new URL(normalizedBaseUrl);
    const normalizedPrefix = String(prefix ?? "").trim();
    if (!normalizedPrefix || normalizedPrefix === "/") {
        return parsed.toString().replace(/\/+$/, "");
    }
    const basePath = parsed.pathname.replace(/\/+$/, "");
    const suffix = normalizedPrefix.startsWith("/") ? normalizedPrefix : `/${normalizedPrefix}`;
    parsed.pathname = `${basePath}${suffix}` || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
}

export function resolveConfiguredCanonicalServerUrl(env: NodeJS.ProcessEnv): string | undefined {
    const configured = normalizeHttpUrl(readServerConfig(env, SERVER_CONFIG.HAPPIER_CANONICAL_SERVER_URL) ?? "");
    if (configured) return configured;

    // Bounded 0.3 transition: historical deployments used the explicitly
    // configured public URL as both profile identity and ingress. Only the
    // deployment's own value qualifies: an address the owner stored or the
    // hosting computer inferred is mutable ingress and never becomes the
    // sign-in audience (invariant I1).
    if (readHomeConfigValueSource(env, SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL.key) !== "deployment") {
        return undefined;
    }
    return resolveConfiguredPublicServerUrl(env);
}

export function resolveConfiguredPublicServerUrl(env: NodeJS.ProcessEnv): string | undefined {
    return normalizeHttpUrl(readServerConfig(env, SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL) ?? "") ?? undefined;
}

export function resolveExplicitWebappUrl(env: NodeJS.ProcessEnv): string | undefined {
    return normalizeHttpUrl(readServerConfig(env, SERVER_CONFIG.HAPPIER_WEBAPP_URL) ?? "") ?? undefined;
}

export function resolveDerivedLocalUiWebappUrl(env: NodeJS.ProcessEnv): string | undefined {
    const publicServerUrl = resolveConfiguredPublicServerUrl(env);
    if (!publicServerUrl) return undefined;
    const uiConfig = resolveUiConfig(env);
    if (!uiConfig.dir) return undefined;
    return appendUiPrefix(publicServerUrl, uiConfig.prefix);
}

export function resolveEffectiveWebappUrl(env: NodeJS.ProcessEnv): string | undefined {
    return resolveExplicitWebappUrl(env) ?? resolveDerivedLocalUiWebappUrl(env);
}

export function resolveEffectiveWebappBaseUrl(env: NodeJS.ProcessEnv): string {
    return resolveEffectiveWebappUrl(env) ?? DEFAULT_WEBAPP_URL;
}
