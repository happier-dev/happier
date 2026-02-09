export function oauthExternalRateLimitPerIp() {
    return {
        max: 60,
        timeWindow: "1 minute",
    };
}

export function oauthExternalRateLimitPerUser() {
    return {
        max: 60,
        timeWindow: "1 minute",
        keyGenerator: (request: any) => request?.userId?.toString?.() ?? request?.ip ?? "unknown",
    };
}
