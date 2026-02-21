import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type ApiRouteRateLimitConfig =
    | false
    | Readonly<{
          max: number;
          timeWindow: string;
          keyGenerator?: (request: any) => string;
      }>;

type ApiRateLimitKeyMode = "auth-or-ip" | "auth-only" | "ip-only";
type ApiRateLimitClientIpSource = "fastify" | "x-forwarded-for" | "x-real-ip";

function resolveApiRateLimitKeyMode(env: Record<string, string | undefined>): ApiRateLimitKeyMode {
    const raw = (env.HAPPIER_API_RATE_LIMIT_KEY_MODE ?? "").trim().toLowerCase();
    if (!raw || raw === "default") return "auth-or-ip";
    if (["auth-or-ip", "auth_or_ip", "authorip"].includes(raw)) return "auth-or-ip";
    if (["auth-only", "auth_only", "auth"].includes(raw)) return "auth-only";
    if (["ip-only", "ip_only", "ip"].includes(raw)) return "ip-only";
    return "auth-or-ip";
}

function resolveApiRateLimitClientIpSource(env: Record<string, string | undefined>): ApiRateLimitClientIpSource {
    const raw = (env.HAPPIER_API_RATE_LIMIT_CLIENT_IP_SOURCE ?? "").trim().toLowerCase();
    if (!raw || raw === "fastify" || raw === "request-ip" || raw === "ip") return "fastify";
    if (["x-forwarded-for", "x_forwarded_for", "forwarded", "xff"].includes(raw)) return "x-forwarded-for";
    if (["x-real-ip", "x_real_ip", "xrealip"].includes(raw)) return "x-real-ip";
    return "fastify";
}

function normalizeProxyIpCandidate(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Common patterns:
    // - "203.0.113.10"
    // - "203.0.113.10:1234"
    // - "[2001:db8::1]:1234"
    // - "2001:db8::1"
    if (trimmed.startsWith("[")) {
        const end = trimmed.indexOf("]");
        if (end > 1) {
            const inside = trimmed.slice(1, end);
            return isIP(inside) ? inside : null;
        }
    }

    if (isIP(trimmed)) return trimmed;

    // IPv4 with port (avoid corrupting IPv6 by only attempting when there is a single ':').
    const parts = trimmed.split(":");
    if (parts.length === 2 && isIP(parts[0] ?? "")) {
        return parts[0]!;
    }

    return null;
}

function resolveRateLimitClientIpFromRequest(
    request: any,
    source: ApiRateLimitClientIpSource,
): string | null {
    const headers: Record<string, unknown> | null =
        request?.headers && typeof request.headers === "object" ? (request.headers as any) : null;

    const fastifyIp = typeof request?.ip === "string" && request.ip.trim().length > 0 ? request.ip.trim() : null;

    if (source === "x-forwarded-for") {
        const raw = headers?.["x-forwarded-for"];
        if (typeof raw === "string" && raw.trim().length > 0) {
            const first = raw.split(",")[0] ?? "";
            const normalized = normalizeProxyIpCandidate(first);
            if (normalized) return normalized;
        }
        return fastifyIp;
    }

    if (source === "x-real-ip") {
        const raw = headers?.["x-real-ip"];
        if (typeof raw === "string" && raw.trim().length > 0) {
            const normalized = normalizeProxyIpCandidate(raw);
            if (normalized) return normalized;
        }
        return fastifyIp;
    }

    return fastifyIp;
}

function buildAuthKey(authHeader: string): string {
    const hash = createHash("sha256").update(authHeader, "utf8").digest("hex").slice(0, 32);
    return `auth:${hash}`;
}

export function createApiRateLimitKeyGenerator(
    env: Record<string, string | undefined> = {},
): (request: any) => string {
    const mode = resolveApiRateLimitKeyMode(env);
    const ipSource = resolveApiRateLimitClientIpSource(env);

    return (request: any) => {
        const authHeader = request?.headers?.authorization;
        const hasAuth = typeof authHeader === "string" && authHeader.trim().length > 0;

        if (mode !== "ip-only" && hasAuth) {
            return buildAuthKey(authHeader);
        }

        if (mode === "auth-only") {
            return "auth:missing";
        }

        const ip = resolveRateLimitClientIpFromRequest(request, ipSource);
        return ip ? `ip:${ip}` : "ip:unknown";
    };
}

export function gateRateLimitConfig(
    env: Record<string, string | undefined>,
    rateLimit: ApiRouteRateLimitConfig,
): ApiRouteRateLimitConfig {
    const enabled = parseBooleanEnv(env.HAPPIER_API_RATE_LIMITS_ENABLED, true);
    if (!enabled) return false;
    return rateLimit;
}

export function resolveApiRateLimitPluginOptions(
    env: Record<string, string | undefined>,
): Readonly<{ global: boolean; max?: number; timeWindow?: string; keyGenerator?: (request: any) => string }> {
    const enabled = parseBooleanEnv(env.HAPPIER_API_RATE_LIMITS_ENABLED, true);
    if (!enabled) {
        return { global: false };
    }

    const globalMax = parseIntEnv(env.HAPPIER_API_RATE_LIMITS_GLOBAL_MAX, 0, { min: 0 });
    const windowRaw = (env.HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW ?? "").trim();
    const timeWindow = windowRaw.length > 0 ? windowRaw : "1 minute";

    const keyGenerator = createApiRateLimitKeyGenerator(env);
    if (globalMax <= 0) {
        return { global: false, keyGenerator };
    }

    return { global: true, max: globalMax, timeWindow, keyGenerator };
}

export function resolveRouteRateLimit(
    env: Record<string, string | undefined>,
    params: Readonly<{
        maxEnvKey: string;
        windowEnvKey: string;
        defaultMax: number;
        defaultWindow: string;
        keyGenerator?: (request: any) => string;
    }>,
): ApiRouteRateLimitConfig {
    const enabled = parseBooleanEnv(env.HAPPIER_API_RATE_LIMITS_ENABLED, true);
    if (!enabled) return false;

    const maxRaw = env[params.maxEnvKey];
    const max = parseIntEnv(maxRaw, params.defaultMax, { min: 0 });
    if (max <= 0) return false;

    const windowRaw = (env[params.windowEnvKey] ?? "").trim();
    const timeWindow = windowRaw.length > 0 ? windowRaw : params.defaultWindow;

    return {
        max,
        timeWindow,
        ...(params.keyGenerator ? { keyGenerator: params.keyGenerator } : null),
    };
}

export function resolveApiTrustProxy(env: Record<string, string | undefined>): boolean | number | undefined {
    const raw = (env.HAPPIER_SERVER_TRUST_PROXY ?? "").trim().toLowerCase();
    if (!raw) return undefined;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    const hops = parseInt(raw, 10);
    if (Number.isFinite(hops) && hops >= 0) return hops;
    return undefined;
}
