/**
 * Normalization and validation of the PostHog API origin.
 *
 * The materialized `posthog-api` Connected Account is the only authority for this
 * value. This module never derives an origin from a configuration token, a provider
 * response, or a `next` URL; it only normalizes and validates what the connection
 * already supplies, and it decides whether a follow-up URL still points at that exact
 * origin before a bearer credential may be attached to it.
 */

/** A validated, canonical HTTPS origin that PostHog requests may target. */
export type PosthogApiOrigin = string & { readonly __posthogApiOrigin: unique symbol };

export type PosthogOriginRejectionReason =
    | 'malformed'
    | 'notHttps'
    | 'containsUserInfo'
    | 'containsPath'
    | 'containsQuery'
    | 'containsFragment'
    | 'ingestHost';

export type PosthogOriginResolution =
    | Readonly<{ ok: true; origin: PosthogApiOrigin }>
    | Readonly<{ ok: false; reason: PosthogOriginRejectionReason }>;

export type PosthogOriginSelectionFailureReason =
    | PosthogOriginRejectionReason
    | 'noOrigin'
    | 'multipleOrigins';

export type PosthogOriginSelection =
    | Readonly<{ ok: true; origin: PosthogApiOrigin }>
    | Readonly<{ ok: false; reason: PosthogOriginSelectionFailureReason }>;

/**
 * PostHog's public ingest hosts are a different host family that carries a write-only
 * project token and cannot read Error Tracking. Accepting one would send a read
 * credential to an endpoint that never needs it.
 */
function isPosthogIngestHost(hostname: string): boolean {
    return hostname === 'i.posthog.com' || hostname.endsWith('.i.posthog.com');
}

function parseUrl(raw: string): URL | null {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

/**
 * Normalizes one candidate origin. Scheme and host are case-insensitive per RFC 3986
 * and are lowercased; the default HTTPS port is omitted while a non-default port is
 * preserved, because a port distinguishes two self-hosted deployments. Anything that
 * is not a bare origin is rejected rather than truncated.
 */
export function normalizePosthogApiOrigin(raw: string): PosthogOriginResolution {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return { ok: false, reason: 'malformed' };
    }
    const url = parseUrl(trimmed);
    if (url === null) {
        return { ok: false, reason: 'malformed' };
    }
    // Scheme is decided before anything else: a non-HTTPS scheme is a credential-
    // disclosure rejection, not an unparseable value.
    if (url.protocol !== 'https:') {
        return { ok: false, reason: 'notHttps' };
    }
    if (url.hostname.length === 0) {
        return { ok: false, reason: 'malformed' };
    }
    if (url.username.length > 0 || url.password.length > 0) {
        return { ok: false, reason: 'containsUserInfo' };
    }
    if (url.hash.length > 0) {
        return { ok: false, reason: 'containsFragment' };
    }
    if (url.search.length > 0) {
        return { ok: false, reason: 'containsQuery' };
    }
    if (url.pathname !== '/' && url.pathname !== '') {
        return { ok: false, reason: 'containsPath' };
    }
    if (isPosthogIngestHost(url.hostname)) {
        return { ok: false, reason: 'ingestHost' };
    }
    // `URL.origin` already lowercases scheme/host and omits the default port.
    return { ok: true, origin: url.origin as PosthogApiOrigin };
}

/**
 * PostHog requires exactly one origin. Zero or several distinct values is a typed
 * configuration-contract failure before any credential is materialized: the source
 * must never guess which deployment an account belongs to.
 */
export function selectPosthogApiOrigin(
    origins: readonly string[],
): PosthogOriginSelection {
    if (origins.length === 0) {
        return { ok: false, reason: 'noOrigin' };
    }
    const normalized: PosthogApiOrigin[] = [];
    for (const candidate of origins) {
        const resolution = normalizePosthogApiOrigin(candidate);
        if (!resolution.ok) {
            return { ok: false, reason: resolution.reason };
        }
        if (!normalized.includes(resolution.origin)) {
            normalized.push(resolution.origin);
        }
    }
    const [only] = normalized;
    if (normalized.length !== 1 || only === undefined) {
        return { ok: false, reason: 'multipleOrigins' };
    }
    return { ok: true, origin: only };
}

/**
 * Compares a provider-returned absolute URL with the materialized origin. A relative,
 * malformed, downgraded, or cross-origin URL is never followed and never receives the
 * authorization header.
 */
export function isSameNormalizedOrigin(
    origin: PosthogApiOrigin,
    candidateUrl: string,
): boolean {
    const url = parseUrl(candidateUrl.trim());
    if (url === null) {
        return false;
    }
    return url.origin === (origin as string);
}
