import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";

export function pairingAuthRateLimitStartPerUser() {
    return resolveApiHotEndpointRateLimit(process.env, "auth.pairing.start");
}

export function pairingAuthRateLimitStatusPerUser() {
    return resolveApiHotEndpointRateLimit(process.env, "auth.pairing.status");
}

export function pairingAuthRateLimitConsumePerUser() {
    return resolveApiHotEndpointRateLimit(process.env, "auth.pairing.consume");
}

export function pairingAuthRateLimitRequestPerIp() {
    return resolveApiHotEndpointRateLimit(process.env, "auth.pairing.request");
}
