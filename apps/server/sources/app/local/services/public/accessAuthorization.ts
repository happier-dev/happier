import type { LocalServicePublicExposureV1, LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { isDeepStrictEqual } from 'node:util';
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

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
    authentication: SessionAccessAuthentication;
}>) => boolean | Promise<boolean>;

export type LocalServicePublicAuthenticatedUser = Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
}>;

export type LocalServicePublicAccessServiceAuthorizer = (input: Readonly<{
    userId: string;
    preview: LocalServicePreviewResourceV1;
    authentication: SessionAccessAuthentication;
}>) => boolean | Promise<boolean>;

export type LocalServicePublicAccessIdentity = Readonly<{
    authenticated: boolean;
    sessionAuthorized: boolean;
}>;

export async function resolveLocalServicePublicAccessIdentity(input: Readonly<{
    exposureId: string;
    principal: LocalServicePublicAuthenticatedUser | null;
    resolveExposure?: (exposureId: string) => LocalServicePublicExposureV1 | null | undefined;
    authorizeSessionAccess?: LocalServicePublicAccessSessionAuthorizer;
    resolvePreview?: (previewId: string) => LocalServicePreviewResourceV1 | null | undefined;
    authorizeServiceAccess?: LocalServicePublicAccessServiceAuthorizer;
}>): Promise<LocalServicePublicAccessIdentity> {
    if (!input.principal) {
        return { authenticated: false, sessionAuthorized: false };
    }
    const exposure = input.resolveExposure?.(input.exposureId) ?? null;
    if (!exposure) {
        return { authenticated: true, sessionAuthorized: false };
    }
    try {
        if (exposure.serviceTarget) {
            const preview = input.resolvePreview?.(exposure.previewId);
            const authorized = preview && preview.machineId === exposure.machineId
                && isDeepStrictEqual(preview.serviceTarget, exposure.serviceTarget) && input.authorizeServiceAccess
                ? await input.authorizeServiceAccess({ userId: input.principal.userId, preview, authentication: input.principal.authentication }) : false;
            return { authenticated: true, sessionAuthorized: authorized === true };
        }
        if (!exposure.sessionId || !input.authorizeSessionAccess) return { authenticated: true, sessionAuthorized: false };
        const authorized = await input.authorizeSessionAccess({
            userId: input.principal.userId,
            sessionId: exposure.sessionId,
            purpose: "public_access",
            authentication: input.principal.authentication,
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
