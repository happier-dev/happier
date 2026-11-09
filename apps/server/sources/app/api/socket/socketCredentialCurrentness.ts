import { Socket } from "socket.io";
import { auth, type VerifiedAuthToken } from "@/app/auth/auth";
import { isRestrictedAuthTokenKind } from "@/app/api/utils/apiTokenRouteAdmission";
import type { RestrictedSocketAdmission } from "./restrictedSocketAdmission";

/**
 * Credential refresh for the disclosure handlers that request it, including
 * restricted PAT viewers' current grants. Route verification uses the Auth
 * owner's ordinary database reader, outside any containing write transaction.
 * Ordinary admitted Machine/Session publisher packets do not use this reader:
 * Account revocation closes their streams through the existing eviction owner.
 */
export async function readCurrentSocketCredential(userId: string, socket: Socket): Promise<VerifiedAuthToken | null> {
    const token = (socket.handshake?.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.length === 0) return null;
    const verified = await auth.verifyTokenForRoute(token);
    if (!verified || verified.userId !== userId) return null;
    if (!isRestrictedAuthTokenKind(verified.authTokenKind)) return verified;
    // Same rule as connect: a restricted credential requires an admitted composition.
    const admission = (socket.data as { ephemeralRunnerAdmission?: RestrictedSocketAdmission } | undefined)
        ?.ephemeralRunnerAdmission;
    if (admission?.kind === "api-token-session-viewer") {
        const principal = verified.apiTokenPrincipal;
        if (verified.authTokenKind !== "api_token" || !principal
            || principal.credentialId !== admission.principal.credentialId) return null;
        socket.data.apiTokenPrincipal = principal;
        socket.data.ephemeralRunnerAdmission = { ...admission, principal };
        return verified;
    }
    return admission !== undefined && admission !== null ? verified : null;
}

export async function hasCurrentSocketCredential(userId: string, socket: Socket): Promise<boolean> {
    return await readCurrentSocketCredential(userId, socket) !== null;
}
