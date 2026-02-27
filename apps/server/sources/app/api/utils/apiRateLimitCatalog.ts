import { createApiRateLimitKeyGenerator, resolveRouteRateLimit, type ApiRouteRateLimitConfig } from "./apiRateLimitPolicy";

type ApiRateLimitDefaults = Readonly<{
    defaultMax: number;
    defaultWindow: string;
    /**
     * How to key the rate limit. Defaults to `user` (verified user id with IP fallback).
     */
    keyMode?: "user" | "ip";
}>;

const API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS = {
    "session.messages": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "session.messages.byLocalId": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "sessions.list": { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    changes: { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    features: { defaultMax: 120, defaultWindow: "1 minute", keyMode: "ip" },
    machines: { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    artifacts: { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    feed: { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "kv.list": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "account.profile": { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "account.settings": { defaultMax: 300, defaultWindow: "1 minute", keyMode: "user" },
    "session.pending": { defaultMax: 600, defaultWindow: "1 minute", keyMode: "user" },
    "session.pending.materialize": { defaultMax: 120, defaultWindow: "1 minute", keyMode: "user" },
    "diagnostics.bugReportSnapshot": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "user" },
    "voice.token": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "voice.sessionComplete": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.start": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.status": { defaultMax: 240, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.consume": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "auth.pairing.request": { defaultMax: 30, defaultWindow: "1 minute", keyMode: "ip" },
    "oauthExternal.authParams": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "ip" },
    "oauthExternal.connectParams": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "user" },
    "oauthExternal.callback": { defaultMax: 60, defaultWindow: "1 minute", keyMode: "ip" },
    "share.public.read": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "ip" },
    "share.public.messages": { defaultMax: 20, defaultWindow: "1 minute", keyMode: "ip" },
    "share.public.manage": { defaultMax: 10, defaultWindow: "1 minute", keyMode: "user" },
    "share.session.create": { defaultMax: 20, defaultWindow: "1 minute", keyMode: "user" },
} as const satisfies Record<string, ApiRateLimitDefaults>;

export type ApiHotEndpointRateLimitId = keyof typeof API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS;

function toUpperSnakeCase(input: string): string {
    const normalized = input
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return normalized.toUpperCase();
}

function resolveRateLimitEnvKeysForId(id: string): { maxEnvKey: string; windowEnvKey: string } {
    const prefix = toUpperSnakeCase(id);
    return {
        maxEnvKey: `HAPPIER_${prefix}_RATE_LIMIT_MAX`,
        windowEnvKey: `HAPPIER_${prefix}_RATE_LIMIT_WINDOW`,
    };
}

export function resolveApiHotEndpointRateLimit(
    env: Record<string, string | undefined>,
    id: ApiHotEndpointRateLimitId,
    opts?: Readonly<{ keyGenerator?: (request: any) => string | Promise<string> }>,
): ApiRouteRateLimitConfig {
    const defaults = API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS[id];
    if (!defaults) return false;
    const keys = resolveRateLimitEnvKeysForId(id);

    const keyGenerator =
        opts?.keyGenerator ??
        (defaults.keyMode === "ip"
            ? createApiRateLimitKeyGenerator(env, { strategy: "ip-only" })
            : createApiRateLimitKeyGenerator(env, { scope: "route" }));

    return resolveRouteRateLimit(env, {
        maxEnvKey: keys.maxEnvKey,
        windowEnvKey: keys.windowEnvKey,
        defaultMax: defaults.defaultMax,
        defaultWindow: defaults.defaultWindow,
        keyGenerator,
    });
}
