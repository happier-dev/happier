import { z } from "zod";
import { db } from "@/storage/db";
import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import {
    AccountEncryptionModeResponseSchema,
    AccountEncryptionCurrentnessResponseSchema,
    AccountEncryptionModeUpdateRequestSchema,
} from "@happier-dev/protocol";
import { type Fastify } from "../../types";
import { updateAccountEncryptionMode } from "./updateAccountEncryptionMode";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    deriveAccountEncryptionMigrationKeyFingerprints,
} from "@/app/encryption/accountEncryptionTransition";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";

export function registerAccountEncryptionRoutes(app: Fastify): void {
    app.get(
        "/v1/account/encryption",
        {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200: AccountEncryptionModeResponseSchema,
                    400: z.object({
                        error: z.literal("migration-required"),
                    }),
                    500: z.object({ error: z.literal("internal") }),
                },
            },
        },
        async (request, reply) => {
            try {
                const user = await db.account.findUnique({
                    where: { id: request.userId },
                    select: {
                        encryptionMode: true,
                        encryptionModeUpdatedAt: true,
                        publicKey: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                    },
                });
                if (!user) {
                    return reply.code(500).send({ error: "internal" });
                }

                const currentness =
                    deriveAccountEncryptionCurrentnessFromRow(user);
                if (currentness.status === "inconsistent") {
                    return reply.code(400).send({
                        error: "migration-required",
                    });
                }
                return reply.send({
                    mode: currentness.currentness.encryptionMode,
                    updatedAt: user.encryptionModeUpdatedAt.getTime(),
                });
            } catch {
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.get(
        "/v1/account/encryption/currentness",
        {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200: AccountEncryptionCurrentnessResponseSchema,
                    400: z.object({
                        error: z.literal("migration-required"),
                    }),
                    500: z.object({ error: z.literal("internal") }),
                },
            },
        },
        async (request, reply) => {
            try {
                const user = await db.account.findUnique({
                    where: { id: request.userId },
                    select: {
                        encryptionMode: true,
                        encryptionModeUpdatedAt: true,
                        publicKey: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                        seq: true,
                    },
                });
                if (!user) {
                    return reply.code(500).send({ error: "internal" });
                }
                const currentness =
                    deriveAccountEncryptionCurrentnessFromRow(user);
                if (currentness.status === "inconsistent") {
                    return reply.code(400).send({
                        error: "migration-required",
                    });
                }
                return reply.send({
                    mode: currentness.currentness.encryptionMode,
                    version: user.seq,
                    ...deriveAccountEncryptionMigrationKeyFingerprints(
                        user,
                    ),
                    updatedAt:
                        user.encryptionModeUpdatedAt.getTime(),
                });
            } catch {
                return reply.code(500).send({ error: "internal" });
            }
        },
    );

    app.patch(
        "/v1/account/encryption",
        {
            preHandler: [
                createServerFeatureGatePreHandler("encryption.accountOptOut"),
                app.authenticate,
                requirePresentUser,
            ],
            schema: {
                body: AccountEncryptionModeUpdateRequestSchema,
                response: {
                    200: AccountEncryptionModeResponseSchema,
                    400: z.object({
                        error: z.enum([
                            "invalid-params",
                            "migration-required",
                            "metadata_privacy_upgrade_required",
                        ]),
                    }),
                    403: PresentUserRequiredResponseSchema,
                    404: z.object({ error: z.literal("not_found") }),
                    500: z.object({ error: z.literal("internal") }),
                },
            },
        },
        async (request, reply) => {
            const requestedMode = request.body.mode;
            const mode = requestedMode === "plain" ? "plain" : "e2ee";

            try {
                const result = await updateAccountEncryptionMode({
                    accountId: request.userId,
                    mode,
                });
                if (result.status === "account_not_found") {
                    return reply.code(500).send({ error: "internal" });
                }
                if (result.status === "migration_required") {
                    return reply.code(400).send({ error: "migration-required" });
                }
                if (
                    result.status
                    === "metadata_privacy_upgrade_required"
                ) {
                    return reply.code(400).send({
                        error: "metadata_privacy_upgrade_required",
                    });
                }
                if (result.status === "invalid_public_key") {
                    return reply.code(400).send({ error: "invalid-params" });
                }
                return reply.send({
                    mode: result.mode,
                    updatedAt: result.updatedAt,
                });
            } catch {
                return reply.code(500).send({ error: "internal" });
            }
        },
    );
}
