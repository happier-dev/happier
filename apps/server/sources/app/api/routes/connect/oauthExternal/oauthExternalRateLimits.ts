import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";

export function oauthExternalRateLimitAuthParamsPerIp() {
    return resolveApiHotEndpointRateLimit(process.env, "oauthExternal.authParams");
}

export function oauthExternalRateLimitCallbackPerIp() {
    return resolveApiHotEndpointRateLimit(process.env, "oauthExternal.callback");
}

export function oauthExternalRateLimitConnectParamsPerUser() {
    return resolveApiHotEndpointRateLimit(process.env, "oauthExternal.connectParams");
}
