import { isLoopbackHostname } from "@/utils/network/urlSafety";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { resolveUiConfig } from "@/app/api/uiConfig";
import { DEFAULT_WEBAPP_URL, resolveEffectiveWebappBaseUrl } from "../../../../serverUrls/effectiveServerUrls";

export function isProviderResetEnabled(env: NodeJS.ProcessEnv): boolean {
    return isServerFeatureEnabledForRequest("auth.recovery.providerReset", env);
}

function parseAllowedOAuthReturnSchemes(env: NodeJS.ProcessEnv): Set<string> {
    const raw = (env.HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES ?? env.HAPPY_OAUTH_RETURN_ALLOWED_SCHEMES ?? "")
        .toString()
        .trim();
    const schemes = new Set<string>();
    if (!raw) return schemes;

    for (const part of raw.split(/[,\s]+/g)) {
        const scheme = part.trim().toLowerCase();
        if (!scheme) continue;
        if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) continue;
        if (scheme === "javascript" || scheme === "data" || scheme === "file" || scheme === "vbscript") continue;
        if (scheme === "http") continue;
        schemes.add(scheme);
    }

    return schemes;
}

function isSafeWebRedirectUrl(env: NodeJS.ProcessEnv, url: URL): boolean {
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "https") return true;
    if (scheme === "http" && isLoopbackHostname(url.hostname)) return true;
    const allowedSchemes = parseAllowedOAuthReturnSchemes(env);
    return allowedSchemes.has(scheme);
}

function tryNormalizeSafeWebRedirectUrl(env: NodeJS.ProcessEnv, raw: string): string | null {
    try {
        const url = new URL(raw);
        if (!isSafeWebRedirectUrl(env, url)) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function resolveWebAppBaseUrlFromEnv(env: NodeJS.ProcessEnv): string {
    return resolveEffectiveWebappBaseUrl(env).trim() || DEFAULT_WEBAPP_URL;
}

function resolveConfiguredWebAppBasePath(env: NodeJS.ProcessEnv): string {
    try {
        const pathname = new URL(resolveWebAppBaseUrlFromEnv(env)).pathname.replace(/\/+$/, "");
        return pathname || "/";
    } catch {
        return "/";
    }
}

function readSingleHeaderValue(headers: Record<string, unknown>, name: string): string {
    const raw = (headers as any)[name] ?? (headers as any)[name.toLowerCase()] ?? (headers as any)[name.toUpperCase()];
    if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : "";
    return typeof raw === "string" ? raw : "";
}

function resolveLoopbackUiBasePath(pathname: string, uiPrefix: string, configuredBasePath: string): string {
    const normalizedUiPrefix = uiPrefix === "/" ? "/" : `/${uiPrefix.replace(/^\/+|\/+$/g, "")}`;
    const normalizedConfiguredBasePath =
        configuredBasePath === "/" ? "/" : `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`;
    if (pathname === "/" && normalizedConfiguredBasePath !== "/") {
        return normalizedConfiguredBasePath;
    }
    if (normalizedUiPrefix === "/") {
        if (
            normalizedConfiguredBasePath !== "/" &&
            (pathname === normalizedConfiguredBasePath || pathname.startsWith(`${normalizedConfiguredBasePath}/`))
        ) {
            return normalizedConfiguredBasePath;
        }
        return normalizedUiPrefix;
    }

    if (pathname === normalizedUiPrefix || pathname.startsWith(`${normalizedUiPrefix}/`)) {
        return normalizedUiPrefix;
    }

    const prefixedSegment = `${normalizedUiPrefix}/`;
    const prefixIndex = pathname.indexOf(prefixedSegment);
    if (prefixIndex >= 0) {
        return pathname.slice(0, prefixIndex + normalizedUiPrefix.length) || normalizedUiPrefix;
    }

    if (pathname.endsWith(normalizedUiPrefix)) {
        return pathname;
    }

    return normalizedUiPrefix;
}

/**
 * Best-effort override for the OAuth return URL based on the requesting web origin.
 *
 * This is intended for local dev / multi-stack scenarios where the server's configured
 * `HAPPIER_WEBAPP_URL` may not match the origin the user started the flow from.
 *
 * Security: we only honor loopback origins (`localhost`, `*.localhost`, `127.0.0.1`, `::1`, etc).
 */
export function resolveWebAppOAuthReturnUrlFromRequestHeaders(params: {
    env: NodeJS.ProcessEnv;
    providerId: string;
    headers: Record<string, unknown>;
}): string | null {
    const providerId = params.providerId.toString().trim().toLowerCase();
    if (!providerId) return null;

    const candidates: string[] = [];
    const referer = readSingleHeaderValue(params.headers, "referer").trim();
    if (referer) candidates.push(referer);
    const origin = readSingleHeaderValue(params.headers, "origin").trim();
    if (origin) candidates.push(origin);
    const uiPrefix = resolveUiConfig(params.env).prefix;
    const configuredWebAppBasePath = resolveConfiguredWebAppBasePath(params.env);

    for (const raw of candidates) {
        try {
            const url = new URL(raw);
            if (!isLoopbackHostname(url.hostname)) continue;
            if (url.protocol !== "http:" && url.protocol !== "https:") continue;
            const loopbackUiBasePath = resolveLoopbackUiBasePath(url.pathname, uiPrefix, configuredWebAppBasePath);
            const returnUrl = `${url.origin}${loopbackUiBasePath.replace(/\/+$/, "")}/oauth/${encodeURIComponent(providerId)}`;
            const normalized = tryNormalizeSafeWebRedirectUrl(params.env, returnUrl);
            if (normalized) return normalized;
        } catch {
            continue;
        }
    }
    return null;
}

export function resolveWebAppOAuthReturnUrlFromEnv(env: NodeJS.ProcessEnv, providerId: string): string {
    const normalizedProvider = providerId.toString().trim().toLowerCase();
    const encodedProvider = encodeURIComponent(normalizedProvider);

    const oauthBaseRaw = (env.HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE ?? env.HAPPY_WEBAPP_OAUTH_RETURN_URL_BASE ?? "")
        .toString()
        .trim();
    if (oauthBaseRaw) {
        const oauthBase = oauthBaseRaw.replace(/\/+$/, "");
        const suffix = `/${encodedProvider}`;
        let candidate: string;
        if (new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?$`).test(oauthBase)) {
            candidate = oauthBase;
        } else if (/^[a-z][a-z0-9+.-]*:\/\/$/i.test(oauthBase)) {
            candidate = `${oauthBase}${encodedProvider}`;
        } else {
            candidate = `${oauthBase}${suffix}`;
        }

        const normalized = tryNormalizeSafeWebRedirectUrl(env, candidate);
        if (normalized) return normalized;
    }

    const base = resolveWebAppBaseUrlFromEnv(env).trim();
    const suffix = `/oauth/${encodedProvider}`;
    if (!base) return `${DEFAULT_WEBAPP_URL}${suffix}`;
    let candidate: string;
    if (new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?$`).test(base)) {
        candidate = base;
    } else if (/^[a-z][a-z0-9+.-]*:\/\/$/i.test(base)) {
        candidate = `${base}oauth/${encodedProvider}`;
    } else {
        candidate = `${base.replace(/\/+$/, "")}${suffix}`;
    }

    const normalized = tryNormalizeSafeWebRedirectUrl(env, candidate);
    if (normalized) return normalized;

    return `${DEFAULT_WEBAPP_URL}${suffix}`;
}

export function buildRedirectUrl(baseUrl: string, params: Record<string, string>): string {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}

export function resolveOAuthPendingTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = (env.OAUTH_PENDING_TTL_SECONDS ?? env.GITHUB_OAUTH_PENDING_TTL_SECONDS ?? "").toString().trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
    const clampedSeconds = Math.max(60, Math.min(3600, seconds));
    return clampedSeconds * 1000;
}

export function resolveOauthStateAttemptTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = (env.OAUTH_STATE_TTL_SECONDS ?? "").toString().trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
    const clampedSeconds = Math.max(60, Math.min(3600, seconds));
    return clampedSeconds * 1000;
}
