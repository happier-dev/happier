import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

import { accountDirectoryAuthErrorHandler } from "@/app/accountDirectory/accountDirectoryErrors";
import { deleteOAuthPendingBestEffort } from "../connectRoutes.oauthPending";
import { AUTH_PROVIDER_CONFIGURATION_CHANGED_ERROR, OAuthProviderConfigurationChangedError } from "./oauthExternalErrors";
import { TeamOAuthAdmissionAbort } from "@/app/teams/memberships/teamOAuthAdmission";
import { InvalidUsernameError, UsernameTakenError } from "@/app/social/usernameUpdate";

export async function oauthExternalFinalizeErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (error instanceof UsernameTakenError) {
        reply.code(409).send({ error: 'username-taken' });
        return reply;
    }
    if (error instanceof InvalidUsernameError) {
        reply.code(400).send({ error: 'invalid-username' });
        return reply;
    }
    if (error instanceof TeamOAuthAdmissionAbort) {
        // The bounded continuation participates in the rejected transaction.
        // Keep its rolled-back, still-expiring row intact so a recoverable policy
        // or mailbox correction can retry without leaving partial Account facts.
        if (error.code === "team_authentication_required") {
            reply.code(403).send({ error: error.code });
        } else {
            reply.code(503).send({ error: error.code });
        }
        return reply;
    }
    if (!(error instanceof OAuthProviderConfigurationChangedError)
        && error.message !== AUTH_PROVIDER_CONFIGURATION_CHANGED_ERROR
        && error.message !== "auth_provider_unavailable") {
        accountDirectoryAuthErrorHandler(error, request, reply);
        return reply;
    }
    // Run outside the rejected mutation transaction so its rollback cannot revive stale state.
    const pendingKey = error instanceof OAuthProviderConfigurationChangedError
        ? error.pendingKey
        : request.body && typeof request.body === "object" && "pending" in request.body
            && typeof request.body.pending === "string" ? request.body.pending : "";
    await deleteOAuthPendingBestEffort(pendingKey);
    reply.code(409).send({ error: AUTH_PROVIDER_CONFIGURATION_CHANGED_ERROR });
    return reply;
}
