import { z } from "zod";
import {
    ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
    AccountApiTokenIntrospectionRequestV1Schema,
    AccountApiTokenIntrospectionSubjectFailureV1Schema,
    AccountApiTokenIntrospectionSuccessV1Schema,
} from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";

import { type Fastify } from "../../types";

const connectionAuthenticationFailureResponseSchema = z.object({
    error: z.enum(["Missing authorization header", "authentication_failed", "Authentication failed"]),
}).strict();

/**
 * Gives a daemon the minimal server-verified PAT principal for its own Account.
 * The daemon connection remains a signed server credential; PATs cannot use
 * this endpoint as their own connection credential.
 */
export function registerApiTokenIntrospectionRoute(app: Fastify): void {
    app.post(
        ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
        {
            onRequest: app.authenticate,
            config: { connectionAuthFailureError: "authentication_failed" },
            schema: {
                body: AccountApiTokenIntrospectionRequestV1Schema,
                response: {
                    200: AccountApiTokenIntrospectionSuccessV1Schema,
                    401: z.union([
                        AccountApiTokenIntrospectionSubjectFailureV1Schema,
                        connectionAuthenticationFailureResponseSchema,
                    ]),
                },
            },
        },
        async (request, reply) => {
            const verified = await auth.verifyPat(request.body.token);
            if (!verified.ok || verified.accountId !== request.userId) {
                return reply.code(401).send({ error: "invalid_token" });
            }

            return reply.send({
                accountId: verified.accountId,
                principalId: verified.principalId,
                credentialId: verified.credentialId,
                expiresAt: verified.expiresAt?.toISOString() ?? null,
                authority: verified.authority,
            });
        },
    );
}
