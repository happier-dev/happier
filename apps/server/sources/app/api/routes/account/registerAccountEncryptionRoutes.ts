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
                    select: { encryptionMode: true, encryptionModeUpdatedAt: true, publicKey: true },
                });
                if (!user) {
                    return reply.code(500).send({ error: "internal" });
                }

                const mode = !user.publicKey ? "plain" : user.encryptionMode === "plain" ? "plain" : "e2ee";
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
                    400: z.object({ error: z.enum(["invalid-params", "migration-required"]) }),
                    404: z.object({ error: z.literal("not_found") }),
                    500: z.object({ error: z.literal("internal") }),
                },
            },
        },
        async (request, reply) => {
            const requestedMode = request.body.mode;
            const mode = requestedMode === "plain" ? "plain" : "e2ee";

            try {
                const account = await db.account.findUnique({
                    where: { id: request.userId },
                    select: { publicKey: true, settings: true },
                });
                if (!account) {
                    return reply.code(500).send({ error: "internal" });
                }

                const hasSettings = typeof account.settings === "string" && account.settings.trim().length > 0;
                const connectedServicesCount = await db.serviceAccountToken.count({ where: { accountId: request.userId } });
                const automationsCount = await db.automation.count({ where: { accountId: request.userId } });
                const requiresMigration = hasSettings || connectedServicesCount > 0 || automationsCount > 0;
                if (requiresMigration) {
                    return reply.code(400).send({ error: "migration-required" });
                }

                if (mode === "e2ee") {
                    if (!account.publicKey) {
                        return reply.code(400).send({ error: "invalid-params" });
                    }
                }

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
