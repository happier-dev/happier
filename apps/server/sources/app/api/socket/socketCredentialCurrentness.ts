import { Socket } from "socket.io";
import { auth } from "@/app/auth/auth";
import { isRestrictedAuthTokenKind } from "@/app/api/utils/apiTokenRouteAdmission";
import type { RestrictedSocketAdmission } from "./restrictedSocketAdmission";

/**
 * Re-runs the socket's own connect-time credential admission, once, at a socket
 * operation that discloses stored content or durably changes Machine authority.
 *
 * Disclosure handlers run it after their stored-content reads. Machine write
 * handlers run it before opening their transaction because route verification
 * uses the Auth owner's ordinary database reader. The transaction still checks
 * the Machine's current availability and version before writing.
 *
 * Eager eviction stays the revocation mechanism: the committed Account
 * transition disconnects the Account's sockets after commit. These call sites
 * are the ones where a socket that outlived its eviction — a lost cross-node
 * disconnect publication — would still hand back material or move Machine
 * authority, so the same `verifyTokenForRoute` + restricted-kind admission the
 * handshake already performs runs there too. PAT viewer operations also refresh
 * their verified grant here. Ordinary viewers and fanout pay nothing; Machine
 * heartbeat publishers use it before emitting current online presence, and
 * machine-bound ordinary Session publishers use it at packet admission.
 * No new predicate, generation or ledger exists.
 */
export async function hasCurrentSocketCredential(userId: string, socket: Socket): Promise<boolean> {
    const token = (socket.handshake?.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.length === 0) return false;
    const verified = await auth.verifyTokenForRoute(token);
    if (!verified || verified.userId !== userId) return false;
    if (!isRestrictedAuthTokenKind(verified.authTokenKind)) return true;
    // Same rule as connect: a restricted credential requires an admitted composition.
    const admission = (socket.data as { ephemeralRunnerAdmission?: RestrictedSocketAdmission } | undefined)
        ?.ephemeralRunnerAdmission;
    if (admission?.kind === "api-token-session-viewer") {
        const principal = verified.apiTokenPrincipal;
        if (verified.authTokenKind !== "api_token" || !principal
            || principal.credentialId !== admission.principal.credentialId) return false;
        socket.data.apiTokenPrincipal = principal;
        socket.data.ephemeralRunnerAdmission = { ...admission, principal };
        return true;
    }
    return admission !== undefined && admission !== null;
}

/**
 * An ordinary requester publisher uses its ordinary Account credential, not a
 * Runner activation. A missed Account socket eviction must not leave that
 * credential publishing effects. Packet admission precedes every installed
 * handler; Session/Machine grant and publisher fencing stay with their existing
 * transaction owners. The authenticated socket owner installs this only for
 * machine-bound ordinary Session publishers, never viewers or Machine daemons.
 */
export function installSessionPublisherCredentialCurrentness(userId: string, socket: Socket): void {
    socket.use(async (_packet, next) => {
        try {
            if (await hasCurrentSocketCredential(userId, socket)) {
                next();
                return;
            }
        } catch {
            // Unverifiable authentication cannot admit an effect. Reconnection
            // goes through the same credential owner as ordinary admission.
        }
        next(new Error("invalid_token"));
        socket.disconnect(true);
    });
}
