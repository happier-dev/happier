import { z } from "zod";
import { PRESENT_USER_REQUIRED_ERROR } from "./apiTokenRouteAdmission";

export { PRESENT_USER_REQUIRED_ERROR } from "./apiTokenRouteAdmission";

// Route imports can reach this guard while the admission module is still initializing.
// Resolve its shared error code at parse time rather than capture an undefined literal.
export const PresentUserRequiredResponseSchema = z.lazy(() => z.object({
    error: z.literal(PRESENT_USER_REQUIRED_ERROR),
}).strict());

type AuthenticatedRouteRequest = Readonly<{
    /** Set only by `enableAuthentication`; absent authority fails closed. */
    authAuthority?: unknown;
    /** Current verifier projection; absent or unknown provenance fails closed. */
    authTokenKind?: unknown;
}>;

type AuthenticatedRouteReply = Readonly<{
    code: (statusCode: 403) => {
        send: (payload: Readonly<{ error: typeof PRESENT_USER_REQUIRED_ERROR }>) => unknown;
    };
}>;

/**
 * Admits only a credential whose server-verified provenance represents a
 * present interactive user. Authentication itself remains responsible for
 * absent and invalid bearer credentials; this guard deliberately knows only
 * the authority stamped after successful authentication.
 */
export async function requirePresentUser(
    request: AuthenticatedRouteRequest,
    reply: AuthenticatedRouteReply,
): Promise<unknown> {
    // Directory credentials intentionally carry present-user authority for
    // identity operations, but must never reach ordinary Home present-user
    // routes. Authentication stamps this kind on every live request; missing,
    // restricted, and unknown provenance all fail closed.
    if (
        request.authAuthority === "present_user"
        && (request.authTokenKind === "account" || request.authTokenKind === "terminal")
    ) return undefined;
    return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
}
