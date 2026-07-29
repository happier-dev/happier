import {
    resolveApiHotEndpointRateLimit,
    type ApiHotEndpointRateLimitId,
} from "@/app/api/utils/apiRateLimitCatalog";
import type { ApiRouteRateLimitConfig } from "@/app/api/utils/apiRateLimitPolicy";

const DEFAULT_WINDOW_MS = 60_000;

const TIME_UNIT_MS: Readonly<Record<string, number>> = {
    ms: 1,
    msec: 1,
    msecs: 1,
    millisecond: 1,
    milliseconds: 1,
    s: 1_000,
    sec: 1_000,
    secs: 1_000,
    second: 1_000,
    seconds: 1_000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
};

/**
 * Parses the human rate-limit window strings used by the catalog
 * (e.g. "1 minute", "30 seconds") into milliseconds. Mirrors the small subset of
 * `@fastify/rate-limit`'s window grammar we actually emit. Falls back to one
 * minute for unrecognized input so the shared throttle never opens wide.
 */
function parseWindowMs(timeWindow: string): number {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(timeWindow);
    if (!match) return DEFAULT_WINDOW_MS;
    const value = Number(match[1]);
    const unitMs = TIME_UNIT_MS[match[2].toLowerCase()];
    if (!Number.isFinite(value) || value <= 0 || typeof unitMs !== "number") return DEFAULT_WINDOW_MS;
    return Math.trunc(value * unitMs);
}

/**
 * The two mint endpoints (`/v1/voice/token` and `/v1/voice/lease/mint`) are
 * deliberate aliases that mint the SAME resource (a voice session lease + an
 * ElevenLabs conversation token).
 *
 * `@fastify/rate-limit` keeps a separate in-memory counter store per registered
 * route, so the per-route `config.rateLimit` budgets are NOT shared across the
 * two aliases — a caller can mint up to `2 × max` tokens per window by
 * alternating endpoints. We therefore enforce a single shared per-user mint
 * budget at the resource chokepoint both routes pass through (the
 * `VoiceSessionLease` table), reusing the catalog's `voice.token` budget so
 * there is one source of truth for the limit.
 */
export const VOICE_MINT_RATE_LIMIT_ID: ApiHotEndpointRateLimitId = "voice.token";

export type VoiceMintRateLimit = Readonly<{
    /** Maximum mints allowed per user within the window. */
    max: number;
    /** Window length in milliseconds. */
    windowMs: number;
}>;

function coerceWindowMs(timeWindow: string | number): number {
    if (typeof timeWindow === "number") {
        return Number.isFinite(timeWindow) && timeWindow > 0 ? Math.trunc(timeWindow) : DEFAULT_WINDOW_MS;
    }
    return parseWindowMs(timeWindow);
}

/**
 * Resolves the shared per-user mint budget from the same catalog entry the
 * per-route rate-limit middleware uses. Returns `null` when rate limiting is
 * disabled (`max <= 0`), in which case the shared throttle is a no-op.
 */
export function resolveVoiceMintRateLimit(env: Record<string, string | undefined>): VoiceMintRateLimit | null {
    const config: ApiRouteRateLimitConfig = resolveApiHotEndpointRateLimit(env, VOICE_MINT_RATE_LIMIT_ID);
    if (config === false) return null;
    const max = config.max;
    if (!Number.isFinite(max) || max <= 0) return null;
    return { max: Math.trunc(max), windowMs: coerceWindowMs(config.timeWindow) };
}

/**
 * Per-route rate-limit config plus the `@fastify/rate-limit` extras the mint
 * aliases need. `groupId`/`errorResponseBuilder` are consumed by the plugin but
 * are not part of the narrow canonical `ApiRouteRateLimitConfig` contract.
 */
type VoiceMintRouteRateLimit =
    | false
    | (Exclude<ApiRouteRateLimitConfig, false> &
          Readonly<{
              groupId: string;
              errorResponseBuilder: () => { statusCode: number; allowed: false; reason: string };
          }>);

/**
 * Returns the per-route `config.rateLimit` for a mint alias. We attach a shared
 * `groupId` so the two aliases are declared as one logical budget (this unifies
 * the buckets automatically if/when the plugin is backed by a shared store), and
 * an `errorResponseBuilder` that returns the route's `{ allowed, reason }` 429
 * contract so the throttle response serializes against the route schema instead
 * of failing serialization (which previously surfaced as a 500).
 */
export function resolveVoiceMintRouteRateLimit(env: Record<string, string | undefined>): VoiceMintRouteRateLimit {
    const base = resolveApiHotEndpointRateLimit(env, VOICE_MINT_RATE_LIMIT_ID);
    if (base === false) return false;
    return {
        ...base,
        groupId: "voice.mint",
        // `statusCode` drives the HTTP status; the route's 429 response schema
        // serializes only `{ allowed, reason }`, dropping `statusCode` from the body.
        errorResponseBuilder: () => ({ statusCode: 429, allowed: false, reason: "too_many_sessions" }),
    };
}
