import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { resolveCredentialActionAdmissionV1 } from "@happier-dev/protocol/actions/decisionAuthority";
import type { FastifyReply, FastifyRequest } from "fastify";

import { PRESENT_USER_REQUIRED_ERROR, requirePresentUser } from "./requirePresentUser";

type RouteActionAuthorityRequest = Pick<FastifyRequest,
    | "authAuthority"
    | "authTokenKind"
    | "apiTokenPrincipal"
    | "externalActionExecutionAuthorized"
    | "externalActionEffectActionId"
    | "externalActionExecutionTarget"
    | "params"
> & Readonly<{ body?: unknown }>;

/**
 * Binds a verified external Action effect to its exact Session route. The
 * authentication owner verifies the credential, current grant and signed
 * target; the ActionSpec remains the authority owner for the domain effect.
 * Raw PATs never acquire a direct mutation path through this guard.
 */
export function requireRouteActionAuthority(actionId: ActionId) {
    const spec = getActionSpec(actionId);
    return async (request: RouteActionAuthorityRequest, reply: FastifyReply): Promise<unknown> => {
        // Person-class credentials pass; the host Action executor's approval
        // policy gates agent-attributed (ceiling-lowered) calls.
        if (request.authTokenKind === "account" || request.authTokenKind === "terminal") {
            return requirePresentUser(request, reply);
        }
        if (
            request.authAuthority !== "account_automation"
            || !resolveCredentialActionAdmissionV1({
                spec,
                authority: request.authAuthority,
                grant: request.apiTokenPrincipal?.grant ?? null,
            }).ok
        ) {
            return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
        }
        const sessionId = typeof request.params === "object" && request.params !== null
            ? Reflect.get(request.params, "sessionId")
            : undefined;
        const target = request.externalActionExecutionTarget;
        if (
            request.authTokenKind === "api_token"
            && request.externalActionExecutionAuthorized === true
            && request.externalActionEffectActionId === actionId
            && target?.kind === "session"
            && typeof sessionId === "string"
            && target.sessionId === sessionId
        ) {
            return undefined;
        }
        return reply.code(403).send({ error: PRESENT_USER_REQUIRED_ERROR });
    };
}
