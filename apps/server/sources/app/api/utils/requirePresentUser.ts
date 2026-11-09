import { z } from "zod/mini";
import { PRESENT_USER_REQUIRED_ERROR } from "./apiTokenRouteAdmission";

export { PRESENT_USER_REQUIRED_ERROR } from "./apiTokenRouteAdmission";

// Route imports can reach this guard while the admission module is still initializing.
// Resolve its shared error code at parse time rather than capture an undefined literal.
export const PresentUserRequiredResponseSchema = z.lazy(() => z.strictObject({
    error: z.literal(PRESENT_USER_REQUIRED_ERROR),
}));

type AuthenticatedRouteRequest = Readonly<{
    /** Current verifier projection; absent or unknown provenance fails closed. */
    authTokenKind?: unknown;
}>;

type AuthenticatedRouteReply = Readonly<{
    code: (statusCode: 403) => {
        send: (payload: Readonly<{ error: typeof PRESENT_USER_REQUIRED_ERROR }>) => unknown;
    };
}>;

/**
 * Admits only a person-class credential: an Account (app) or terminal (CLI
 * login) credential, whatever its per-invocation authority. An
 * `account_automation` authority ceiling attributes an agent- or
 * plugin-originated call; the host Action executor's per-Action approval
 * policy gates that call, so the ceiling does not make this route refuse.
 * Authentication remains responsible for absent and invalid bearers.
 */
export async function requirePresentUser(
    request: AuthenticatedRouteRequest,
    reply: AuthenticatedRouteReply,
): Promise<unknown> {
    // Scoped credentials are never a person: API tokens, Account Directory
    // credentials (identity operations only), ephemeral Session runners, and
    // missing or unknown provenance all fail closed.
    if (request.authTokenKind === "account" || request.authTokenKind === "terminal") return undefined;
    return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
}
