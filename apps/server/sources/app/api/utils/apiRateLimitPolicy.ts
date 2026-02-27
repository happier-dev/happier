import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { auth } from "@/app/auth/auth";

export type ApiRouteRateLimitConfig =
    | false
    | Readonly<{
          max: number;
          timeWindow: string;
          keyGenerator?: (request: any) => string | Promise<string>;
      }>;

export type ApiRateLimitKeyStrategy = "user-or-ip" | "ip-only";

const API_RATE_LIMIT_MAX_IP_KEY_LENGTH = 256;
const API_RATE_LIMIT_MAX_BEARER_TOKEN_LENGTH = 2048;
const API_RATE_LIMIT_MAX_USER_ID_LENGTH = 128;

function resolveApiRateLimitKeyStrategy(
    env: Record<string, string | undefined>,
    opts: { scope: "route" | "global" },
): ApiRateLimitKeyStrategy {
    const key = opts.scope === "global" ? "HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY" : "HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY";
    const raw = String(env[key] ?? "").trim().toLowerCase();
    if (!raw || raw === "default") {
        return opts.scope === "global" ? "ip-only" : "user-or-ip";
    }
    if (["ip", "ip-only", "ip_only"].includes(raw)) return "ip-only";
    if (["user", "user-or-ip", "user_or_ip", "userorip"].includes(raw)) return "user-or-ip";
    return opts.scope === "global" ? "ip-only" : "user-or-ip";
}

function resolveIpKey(request: any): string {
    const ip = typeof request?.ip === "string" ? request.ip.trim() : "";
    const safeIp = ip.length > API_RATE_LIMIT_MAX_IP_KEY_LENGTH ? ip.slice(0, API_RATE_LIMIT_MAX_IP_KEY_LENGTH) : ip;
    return safeIp ? `ip:${safeIp}` : "ip:unknown";
}

function parseBearerTokenFromRequest(request: any): string | null {
    const raw = request?.headers?.authorization;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase().startsWith("bearer ")) {
        const token = trimmed.slice(7).trim();
        if (!token) return null;
        if (token.length > API_RATE_LIMIT_MAX_BEARER_TOKEN_LENGTH) return null;
        return token;
    }
    return null;
}

export function createApiRateLimitKeyGenerator(
    env: Record<string, string | undefined> = {},
    opts?: Readonly<{ strategy?: ApiRateLimitKeyStrategy; scope?: "route" | "global" }>,
): (request: any) => Promise<string> {
    const strategy =
        opts?.strategy ??
        resolveApiRateLimitKeyStrategy(env, {
            scope: opts?.scope ?? "route",
        });

    return async (request: any) => {
        const ipKey = resolveIpKey(request);
        if (strategy === "ip-only") {
            return ipKey;
        }

        const token = parseBearerTokenFromRequest(request);
        if (!token) return ipKey;

        try {
            const verified = await auth.verifyToken(token);
            const userId = verified?.userId;
            if (typeof userId === "string") {
                const trimmed = userId.trim();
                if (trimmed.length > 0 && trimmed.length <= API_RATE_LIMIT_MAX_USER_ID_LENGTH) {
                    return `uid:${trimmed}`;
                }
            }
        } catch {
            // fail closed to IP
        }
        return ipKey;
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
): Readonly<{ global: boolean; max?: number; timeWindow?: string; keyGenerator?: (request: any) => string | Promise<string> }> {
    const enabled = parseBooleanEnv(env.HAPPIER_API_RATE_LIMITS_ENABLED, true);
    if (!enabled) {
        return { global: false };
    }

    const globalMax = parseIntEnv(env.HAPPIER_API_RATE_LIMITS_GLOBAL_MAX, 0, { min: 0 });
    const windowRaw = (env.HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW ?? "").trim();
    const timeWindow = windowRaw.length > 0 ? windowRaw : "1 minute";

    const keyGenerator = createApiRateLimitKeyGenerator(env, { scope: "global" });
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
        keyGenerator?: (request: any) => string | Promise<string>;
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
    if (["true", "yes", "on"].includes(raw)) return true;
    if (["false", "no", "off"].includes(raw)) return false;
    const hops = parseInt(raw, 10);
    if (Number.isFinite(hops) && hops >= 0) return hops;
    return undefined;
}
