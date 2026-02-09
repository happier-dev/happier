import * as privacyKit from "privacy-kit";
import { z } from "zod";

import { type Fastify } from "../../../types";
import { connectExternalIdentity } from "@/app/auth/providers/identity";
import { Context } from "@/context";
import { decryptString } from "@/modules/encrypt";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { db } from "@/storage/db";
import { validateUsername } from "@/app/social/usernamePolicy";
import { deleteOAuthPendingBestEffort, loadValidOAuthPending } from "../connectRoutes.oauthPending";
import { PROVIDER_ALREADY_LINKED_ERROR } from "./oauthExternalErrors";
import { connectPendingSchema } from "./oauthExternalSchemas";
import {
    ExternalOAuthFinalizeConnectRequestSchema,
    ExternalOAuthFinalizeConnectSuccessResponseSchema,
} from "@happier-dev/protocol";

export function registerExternalConnectFinalizeRoute(app: Fastify) {
    app.post("/v1/connect/external/:provider/finalize", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string() }),
            body: ExternalOAuthFinalizeConnectRequestSchema,
            response: {
                200: ExternalOAuthFinalizeConnectSuccessResponseSchema,
                400: z.object({ error: z.enum(["invalid-pending", "invalid-username"]) }),
                403: z.object({ error: z.enum(["forbidden", "not-eligible"]) }),
                404: z.object({ error: z.literal("unsupported-provider") }),
                409: z.union([
                    z.object({ error: z.literal("username-taken") }),
                    z.object({ error: z.literal(PROVIDER_ALREADY_LINKED_ERROR), provider: z.string() }),
                ]),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const pendingKey = request.body.pending.toString().trim();
        if (!pendingKey) return reply.code(400).send({ error: "invalid-pending" });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.code(400).send({ error: "invalid-pending" });

        let parsedValue: z.infer<typeof connectPendingSchema>;
        try {
            const parsed = connectPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) {
                await deleteOAuthPendingBestEffort(pendingKey);
                return reply.code(400).send({ error: "invalid-pending" });
            }
            parsedValue = parsed.data;
        } catch {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        if (parsedValue.provider.toString().trim().toLowerCase() !== providerId) {
            return reply.code(403).send({ error: "forbidden" });
        }
        if (parsedValue.userId !== request.userId) {
            return reply.code(403).send({ error: "forbidden" });
        }

        const validation = validateUsername(request.body.username, process.env);
        if (!validation.ok) return reply.code(400).send({ error: "invalid-username" });
        const username = validation.username;

        const taken = await db.account.findFirst({
            where: {
                username,
                NOT: { id: request.userId },
            },
            select: { id: true },
        });
        if (taken) return reply.code(409).send({ error: "username-taken" });

        let accessToken: string;
        let refreshToken: string | undefined;
        let pendingProfile: unknown;
        try {
            const tokenBytes = privacyKit.decodeBase64(parsedValue.accessTokenEnc);
            accessToken = decryptString(["user", request.userId, "connect", providerId, "pending", pendingKey], tokenBytes);
            if (typeof parsedValue.refreshTokenEnc === "string" && parsedValue.refreshTokenEnc.trim()) {
                const refreshBytes = privacyKit.decodeBase64(parsedValue.refreshTokenEnc);
                refreshToken = decryptString(
                    ["user", request.userId, "connect", providerId, "pending", pendingKey, "refresh"],
                    refreshBytes,
                );
            }

            const profileBytes = privacyKit.decodeBase64(parsedValue.profileEnc);
            const profileJson = decryptString(
                ["user", request.userId, "connect", providerId, "pending", pendingKey, "profile"],
                profileBytes,
            );
            pendingProfile = JSON.parse(profileJson);
        } catch {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const ctx = Context.create(request.userId);
        try {
            await connectExternalIdentity({
                providerId,
                ctx,
                profile: pendingProfile,
                accessToken,
                refreshToken,
                preferredUsername: username,
            });
        } catch (error) {
            if (error instanceof Error && error.message === "not-eligible") {
                return reply.code(403).send({ error: "not-eligible" });
            }
            if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }
            throw error;
        }

        await deleteOAuthPendingBestEffort(pendingKey);
        return reply.send({ success: true });
    });
}
