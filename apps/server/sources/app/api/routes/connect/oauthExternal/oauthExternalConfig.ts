import { isLoopbackHostname } from "@/utils/network/urlSafety";

function parseBooleanEnvFallback(raw: string | undefined, fallback: boolean): boolean {
    const value = (raw ?? "").toString().trim().toLowerCase();
    if (!value) return fallback;
    if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
    if (value === "0" || value === "false" || value === "no" || value === "off") return false;
    return fallback;
}

export function isProviderResetEnabled(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnvFallback(env.AUTH_RECOVERY_PROVIDER_RESET_ENABLED, true);
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
    return (env.HAPPIER_WEBAPP_URL ?? env.HAPPY_WEBAPP_URL ?? "https://app.happier.dev").toString().trim() || "https://app.happier.dev";
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
    if (!base) return `https://app.happier.dev${suffix}`;
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

    return `https://app.happier.dev${suffix}`;
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
