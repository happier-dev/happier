import {
    resolveApiHotEndpointRateLimit,
    type ApiHotEndpointRateLimitId,
} from "@/app/api/utils/apiRateLimitCatalog";
import type { ApiRouteRateLimitConfig } from "@/app/api/utils/apiRateLimitPolicy";
import type { Fastify } from "../../types";

export const VOICE_MINT_RATE_LIMIT_ID: ApiHotEndpointRateLimitId = "voice.token";

/**
 * The Fastify route limiter is the only request-attempt budget for the mint
 * aliases. `voiceRoutes` creates one handler from these options and attaches
 * it to both aliases; durable voice-lease rows remain lifecycle and quota
 * state, never a second rate-limit ledger.
 */
type VoiceMintRouteRateLimit =
    | false
    | (Exclude<ApiRouteRateLimitConfig, false> &
          Readonly<{
              errorResponseBuilder: () => { statusCode: number; allowed: false; reason: string };
          }>);

export type VoiceMintRateLimitHandler = ReturnType<Fastify["rateLimit"]>;

/**
 * Returns the options for the single Fastify handler shared by both mint
 * aliases, including the route's schema-compatible 429 response.
 */
export function resolveVoiceMintRouteRateLimit(env: Record<string, string | undefined>): VoiceMintRouteRateLimit {
    const base = resolveApiHotEndpointRateLimit(env, VOICE_MINT_RATE_LIMIT_ID);
    if (base === false) return false;
    return {
        ...base,
        // `statusCode` drives the HTTP status; the route's 429 response schema
        // serializes only `{ allowed, reason }`, dropping `statusCode` from the body.
        errorResponseBuilder: () => ({ statusCode: 429, allowed: false, reason: "too_many_sessions" }),
    };
}
