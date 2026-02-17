import { z } from "zod";

import { type Fastify } from "../../types";
import { Context } from "@/context";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { disconnectExternalIdentity } from "@/app/auth/providers/identity";
import { deleteOAuthPendingBestEffort, loadValidOAuthPending } from "./connectRoutes.oauthPending";
import { createExternalAuthorizeUrl } from "./oauthExternal/createExternalAuthorizeUrl";
import { oauthExternalRateLimitPerUser } from "./oauthExternal/oauthExternalRateLimits";
import { connectPendingSchema } from "./oauthExternal/oauthExternalSchemas";
import { OAUTH_STATE_UNAVAILABLE_CODE } from "@/app/auth/oauthStateErrors";
import { OAUTH_NOT_CONFIGURED_ERROR } from "./oauthExternal/oauthExternalErrors";
import { registerExternalConnectFinalizeRoute } from "./oauthExternal/registerExternalConnectFinalizeRoute";
import { ExternalOAuthErrorResponseSchema, ExternalOAuthParamsResponseSchema } from "@happier-dev/protocol";
import { NotFoundSchema } from "../../schemas/notFoundSchema";

export function connectConnectExternalRoutes(app: Fastify) {
    //
    // External provider connection (authenticated identity linking)
    //

    app.get("/v1/connect/external/:provider/params", {
        preHandler: app.authenticate,
        config: { rateLimit: oauthExternalRateLimitPerUser() },
        schema: {
            params: z.object({ provider: z.string() }),
            response: {
                200: ExternalOAuthParamsResponseSchema,
                400: ExternalOAuthErrorResponseSchema,
                404: z.union([NotFoundSchema, z.object({ error: z.literal("unsupported-provider") })]),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        try {
            const url = await createExternalAuthorizeUrl({
                flow: "connect",
                env: process.env,
                providerId,
                provider,
                userId: request.userId,
            });
            if (!url) return reply.code(400).send({ error: OAUTH_STATE_UNAVAILABLE_CODE });
            return reply.send({ url });
        } catch (error) {
            if (error instanceof Error && error.message === OAUTH_NOT_CONFIGURED_ERROR) {
                return reply.code(400).send({ error: OAUTH_NOT_CONFIGURED_ERROR });
            }
            throw error;
        }
    });

    registerExternalConnectFinalizeRoute(app);

    app.delete("/v1/connect/external/:provider/pending/:pending", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string(), pending: z.string() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("unsupported-provider") })]),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const pendingKey = request.params.pending.toString().trim();
        if (!pendingKey) return reply.send({ success: true });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.send({ success: true });
        try {
            const parsed = connectPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) return reply.send({ success: true });
            if (parsed.data.userId !== request.userId) return reply.send({ success: true });
        } catch {
            return reply.send({ success: true });
        }
        await deleteOAuthPendingBestEffort(pendingKey);
        return reply.send({ success: true });
    });

    app.delete("/v1/connect/external/:provider", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("unsupported-provider") })]),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const ctx = Context.create(request.userId);
        await disconnectExternalIdentity({ providerId, ctx });
        return reply.send({ success: true });
    });
}

