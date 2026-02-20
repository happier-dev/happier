import { z } from "zod";
import { db } from "@/storage/db";
import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import {
    AccountEncryptionModeResponseSchema,
    AccountEncryptionModeUpdateRequestSchema,
} from "@happier-dev/protocol";
import { type Fastify } from "../../types";

export function registerAccountEncryptionRoutes(app: Fastify): void {
    app.get(
        "/v1/account/encryption",
        {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200: AccountEncryptionModeResponseSchema,
                    500: z.object({ error: z.literal("internal") }),
                },
            },
        },
        async (request, reply) => {
            try {
                const user = await db.account.findUnique({
                    where: { id: request.userId },
                    select: { encryptionMode: true, encryptionModeUpdatedAt: true },
                });
                if (!user) {
                    return reply.code(500).send({ error: "internal" });
                }

                const mode = user.encryptionMode === "plain" ? "plain" : "e2ee";
                return reply.send({ mode, updatedAt: user.encryptionModeUpdatedAt.getTime() });
            } catch {
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.patch(
        "/v1/account/encryption",
        {
            preHandler: [createServerFeatureGatePreHandler("encryption.accountOptOut"), app.authenticate],
            schema: {
                body: AccountEncryptionModeUpdateRequestSchema,
                response: {
                    200: AccountEncryptionModeResponseSchema,
                    400: z.object({ error: z.literal("invalid-params") }),
                    404: z.object({ error: z.literal("not_found") }),
                    500: z.object({ error: z.literal("internal") }),
                },
            },
        },
        async (request, reply) => {
            const requestedMode = request.body.mode;
            const mode = requestedMode === "plain" ? "plain" : "e2ee";

            try {
                const updated = await db.account.update({
                    where: { id: request.userId },
                    data: { encryptionMode: mode, encryptionModeUpdatedAt: new Date() },
                    select: { encryptionMode: true, encryptionModeUpdatedAt: true },
                });

                const storedMode = updated.encryptionMode === "plain" ? "plain" : "e2ee";
                return reply.send({ mode: storedMode, updatedAt: updated.encryptionModeUpdatedAt.getTime() });
            } catch {
                return reply.code(500).send({ error: "internal" });
            }
        },
    );
}
