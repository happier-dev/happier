import { z } from "zod";
import { PRESENT_USER_REQUIRED_ERROR } from "./apiTokenRouteAdmission";

export { PRESENT_USER_REQUIRED_ERROR } from "./apiTokenRouteAdmission";

export const PresentUserRequiredResponseSchema = z.object({
    error: z.literal(PRESENT_USER_REQUIRED_ERROR),
}).strict();

type AuthenticatedRouteRequest = Readonly<{
    /** Set only by `enableAuthentication`; absent authority fails closed. */
    authAuthority?: unknown;
}>;

type AuthenticatedRouteReply = Readonly<{
    code: (statusCode: number) => {
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
    if (request.authAuthority === "present_user") return undefined;
    return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
}
