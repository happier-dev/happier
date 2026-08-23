import type { LocalServicePublicExposureV1 } from "@happier-dev/protocol";

/**
 * Canonical owner of the two access-time facts a public exposure request carries beyond its
 * token: WHO is asking (S-2) and WHICH client bucket the request belongs to (S-5).
 *
 * S-2: `authenticated` only ever proved that the caller holds some account on this server, and
 * `mode:'authenticated'` exposures were reachable by any of them. The exposure is bound to one
 * session, so access requires access to that session. Resolution fails closed: no user, no
 * exposure resolver, no authorizer, or a throwing authorizer all yield `sessionAuthorized:false`.
 */
export type LocalServicePublicAccessPurpose = "public_access";

export type LocalServicePublicAccessSessionAuthorizer = (input: Readonly<{
    userId: string;
    sessionId: string;
    purpose: LocalServicePublicAccessPurpose;
}>) => boolean | Promise<boolean>;

export type LocalServicePublicAccessIdentity = Readonly<{
    authenticated: boolean;
    sessionAuthorized: boolean;
}>;

export async function resolveLocalServicePublicAccessIdentity(input: Readonly<{
    exposureId: string;
    userId: string | null;
    resolveExposure?: (exposureId: string) => LocalServicePublicExposureV1 | null | undefined;
    authorizeSessionAccess?: LocalServicePublicAccessSessionAuthorizer;
}>): Promise<LocalServicePublicAccessIdentity> {
    if (!input.userId) {
        return { authenticated: false, sessionAuthorized: false };
    }
    const exposure = input.resolveExposure?.(input.exposureId) ?? null;
    if (!exposure || !input.authorizeSessionAccess) {
        return { authenticated: true, sessionAuthorized: false };
    }
    try {
        const authorized = await input.authorizeSessionAccess({
            userId: input.userId,
            sessionId: exposure.sessionId,
            purpose: "public_access",
        });
        return { authenticated: true, sessionAuthorized: authorized === true };
    } catch {
        return { authenticated: true, sessionAuthorized: false };
    }
}

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
