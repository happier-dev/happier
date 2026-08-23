import { z } from "zod";

import { auth } from "@/app/auth/auth";

import { type Fastify } from "../../types";

// `app.authenticate` owns connection-credential failures and can return its
// existing 401 envelope before this handler runs. PAT-subject failures below
// remain the exact opaque `invalid_token` value.
const authenticationFailureResponseSchema = z.object({ error: z.string() }).strict();

const apiTokenIntrospectionResponseSchema = z.object({
    accountId: z.string(),
    principalId: z.string(),
    credentialId: z.string(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    authority: z.literal("account_automation"),
}).strict();

/**
 * Gives a daemon the minimal server-verified PAT principal for its own Account.
 * The daemon connection remains a signed server credential; PATs cannot use
 * this endpoint as their own connection credential.
 */
export function registerApiTokenIntrospectionRoute(app: Fastify): void {
    app.post(
        "/v1/auth/api-tokens/introspect",
        {
            preHandler: app.authenticate,
            // Permit the handler to return its opaque rejection when a PAT is
            // misused as the daemon connection credential; it never grants
            // that credential connection authority.
            config: { allowApiToken: true },
            schema: {
                body: z.object({ token: z.unknown() }).strict(),
                response: {
                    200: apiTokenIntrospectionResponseSchema,
                    401: authenticationFailureResponseSchema,
                },
            },
        },
        async (request, reply) => {
            // A PAT is only the subject of this request. The authenticated
            // connection must remain an existing signed Account/terminal token.
            if (request.authTokenKind === "api_token" || typeof request.body.token !== "string") {
                return reply.code(401).send({ error: "invalid_token" });
            }

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
