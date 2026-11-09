/**
 * Canonical owner of the client bucket a public exposure request belongs to (S-5).
 * Viewer identity for `people` shares is decided once at admission by the public runtime
 * and carried by the viewer-bound cookie, so the data planes read no Account identity here.
 */
/**
 * S-5: the rate-limit bucket must be keyed by the CLIENT, not only by the exposure, or a single
 * visitor exhausts the window for everyone holding the link. Fastify's `request.ip` already
 * applies the server's `trustProxy` policy, so it is preferred over reading a spoofable
 * forwarding header here. Requests whose client cannot be identified share one `unknown` bucket:
 * still limited, and no longer able to deny the link permanently now that `rate_limited` is
 * transient.
 */
export const LOCAL_SERVICE_PUBLIC_UNKNOWN_CLIENT_KEY = "unknown";

export function readLocalServicePublicClientKey(
    candidates: readonly (string | null | undefined)[],
): string {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return LOCAL_SERVICE_PUBLIC_UNKNOWN_CLIENT_KEY;
}
