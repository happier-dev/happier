import { resolveUiConfig } from "../api/uiConfig";

export const DEFAULT_WEBAPP_URL = "https://app.happier.dev";

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
    return normalizeHttpUrl(String(env.HAPPIER_PUBLIC_SERVER_URL ?? "")) ?? undefined;
}

export function resolveExplicitWebappUrl(env: NodeJS.ProcessEnv): string | undefined {
    return normalizeHttpUrl(String(env.HAPPIER_WEBAPP_URL ?? env.HAPPY_WEBAPP_URL ?? "")) ?? undefined;
}

export function resolveDerivedLocalUiWebappUrl(env: NodeJS.ProcessEnv): string | undefined {
    const canonicalServerUrl = resolveConfiguredCanonicalServerUrl(env);
    if (!canonicalServerUrl) return undefined;
    const uiConfig = resolveUiConfig(env);
    if (!uiConfig.dir) return undefined;
    return appendUiPrefix(canonicalServerUrl, uiConfig.prefix);
}

export function resolveEffectiveWebappUrl(env: NodeJS.ProcessEnv): string | undefined {
    return resolveExplicitWebappUrl(env) ?? resolveDerivedLocalUiWebappUrl(env);
}

export function resolveEffectiveWebappBaseUrl(env: NodeJS.ProcessEnv): string {
    return resolveEffectiveWebappUrl(env) ?? DEFAULT_WEBAPP_URL;
}
