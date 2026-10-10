import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol/crypto/publicShareCapabilityUrl';

/**
 * Returns the log-safe projection of an HTTP request URL.
 *
 * The query string and fragment are removed universally — there is no query
 * allowlist — so OAuth `code`/`state`, correlation ids, grants, or any other
 * query material can never survive into logs, error/404/auth diagnostics, or
 * Sentry projections. The remaining pathname is then passed through the
 * existing sensitive path-capability redactor
 * (`redactPublicShareCapabilityUrl`) so public-share and browser-Artifact
 * bearer path segments still become `:token`. The method is untouched and the
 * pathname is preserved verbatim.
 *
 * This is the single owner for request-URL log redaction; do not split query
 * strings or re-implement capability templating at call sites.
 */
export function redactHttpRequestUrlForLog(rawUrl: string): string {
    const queryOrFragmentStart = rawUrl.search(/[?#]/);
    const pathname = queryOrFragmentStart === -1 ? rawUrl : rawUrl.slice(0, queryOrFragmentStart);
    return redactPublicShareCapabilityUrl(pathname);
}
