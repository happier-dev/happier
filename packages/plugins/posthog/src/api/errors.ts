/**
 * Boundary failure mapping for PostHog responses.
 *
 * PostHog's published Error Tracking contract declares no `401`, `403`, or `429`
 * response on any of its 55 paths, so a client cannot read the intended meaning of a
 * failure out of the schema. Classification is therefore driven purely by the observed
 * response: status plus whatever retry evidence the provider actually returned. No
 * local quota, backoff schedule, or reset instant is invented here, and no provider
 * error text crosses this boundary.
 */

export type PosthogFailure =
    | Readonly<{ kind: 'unauthorized'; status: number }>
    | Readonly<{ kind: 'forbidden'; status: number }>
    | Readonly<{ kind: 'notFound'; status: number }>
    | Readonly<{ kind: 'rateLimited'; status: number; retryNotBeforeMs?: number }>
    /** A 3xx is surfaced, never followed: following it would silently read a different resource. */
    | Readonly<{ kind: 'redirected'; status: number }>
    | Readonly<{ kind: 'server'; status: number }>
    | Readonly<{ kind: 'unexpectedStatus'; status: number }>
    | Readonly<{ kind: 'transport' }>
    | Readonly<{ kind: 'timeout' }>
    | Readonly<{ kind: 'cancelled' }>
    /** A response that parsed as JSON but did not satisfy the strict envelope contract. */
    | Readonly<{ kind: 'malformedResponse'; at: string }>
    /** A follow-up URL that left the materialized origin; no credential was sent to it. */
    | Readonly<{ kind: 'originMismatch' }>
    /** The source could not construct a valid request from its own inputs. */
    | Readonly<{ kind: 'requestInvalid'; at: string }>;

/**
 * Reads RFC 9110 `Retry-After` in both accepted forms. Anything else — an absent,
 * empty, negative, fractional, unparseable, or already-elapsed value — yields `null`
 * so the typed failure omits the field rather than asserting a deadline the provider
 * never gave.
 */
export function parseRetryAfterMs(responseHeaders: Headers, nowMs: number): number | null {
    const raw = responseHeaders.get('retry-after');
    if (raw === null) {
        return null;
    }
    const value = raw.trim();
    if (value.length === 0) {
        return null;
    }
    if (/^\d+$/u.test(value)) {
        const seconds = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(seconds)) {
            return null;
        }
        return nowMs + (seconds * 1_000);
    }
    const at = Date.parse(value);
    if (Number.isNaN(at) || at < nowMs) {
        return null;
    }
    return at;
}

function rateLimited(status: number, retryNotBeforeMs: number | null): PosthogFailure {
    return retryNotBeforeMs === null
        ? { kind: 'rateLimited', status }
        : { kind: 'rateLimited', status, retryNotBeforeMs };
}

/**
 * Maps one observed response status to a typed failure, or `null` when the status is a
 * success and the caller should parse the body.
 *
 * A bare `403` stays a permission failure: PostHog uses `403` for authorization and its
 * exhaustion status is uncharacterized, so collapsing the two would hide a real missing
 * scope behind a fictional throttle. A `403` is reclassified as throttling only when it
 * carries a valid `Retry-After`, which is the provider's own retry evidence rather than
 * a framework inference.
 */
export function classifyPosthogResponseStatus(
    status: number,
    responseHeaders: Headers,
    nowMs: number,
): PosthogFailure | null {
    if (status >= 200 && status < 300) {
        return null;
    }
    const retryNotBeforeMs = parseRetryAfterMs(responseHeaders, nowMs);
    if (status === 429) {
        return rateLimited(status, retryNotBeforeMs);
    }
    if (status === 403) {
        return retryNotBeforeMs === null
            ? { kind: 'forbidden', status }
            : rateLimited(status, retryNotBeforeMs);
    }
    if (status === 401) {
        return { kind: 'unauthorized', status };
    }
    if (status === 404) {
        return { kind: 'notFound', status };
    }
    if (status >= 300 && status < 400) {
        return { kind: 'redirected', status };
    }
    if (status >= 500) {
        return { kind: 'server', status };
    }
    return { kind: 'unexpectedStatus', status };
}

/** True when a later view-driven refresh should consult provider retry evidence. */
export function isPosthogRateLimitFailure(
    failure: PosthogFailure,
): failure is Extract<PosthogFailure, Readonly<{ kind: 'rateLimited' }>> {
    return failure.kind === 'rateLimited';
}
