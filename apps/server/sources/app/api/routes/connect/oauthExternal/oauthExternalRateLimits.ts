import { createApiRateLimitKeyGenerator, gateRateLimitConfig } from "@/app/api/utils/apiRateLimitPolicy";

export function oauthExternalRateLimitPerIp() {
    return gateRateLimitConfig(process.env, {
        max: 60,
        timeWindow: "1 minute",
    });
}

export function oauthExternalRateLimitPerUser() {
    return gateRateLimitConfig(process.env, {
        max: 60,
        timeWindow: "1 minute",
        keyGenerator: createApiRateLimitKeyGenerator(),
    });
}
