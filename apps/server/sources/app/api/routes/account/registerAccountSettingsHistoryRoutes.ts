import { z } from "zod";

import { AccountSettingsStoredContentEnvelopeSchema } from "@happier-dev/protocol";

import {
    accountSettingsSnapshotToContent,
    resolveAccountSettingsSnapshotContentKind,
} from "@/app/accountSettings/accountSettingsHistoryContent";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { type Fastify } from "../../types";
import {
    AccountSettingsStorageUnavailableResponseSchema,
    resolveAccountSettingsStorageUnavailableRouteError,
} from "./accountSettingsStorageUnavailableRouteError";

const AccountSettingsHistoryVersionParamsSchema = z.object({
    version: z.coerce.number().int().min(0),
});

const AccountSettingsHistoryContentKindSchema = z.enum(["encrypted", "plain", "empty"]);

const AccountSettingsHistoryListResponseSchema = z.object({
    snapshots: z.array(z.object({
        version: z.number().int().min(0),
        createdAt: z.string(),
        contentKind: AccountSettingsHistoryContentKindSchema,
        byteLength: z.number().int().min(0),
    })),
});

const AccountSettingsHistoryDetailResponseSchema = z.object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    version: z.number().int().min(0),
    createdAt: z.string(),
});

const AccountSettingsHistoryRestoreClientUpdateRequiredResponseSchema = z.object({
    error: z.literal("account_settings_restore_client_update_required"),
}).strict();

const AccountSettingsHistoryErrorResponseSchema = z.object({
    error: z.union([
        z.literal("invalid-params"),
        z.literal("not_found"),
        z.literal("internal"),
    ]),
});

export function registerAccountSettingsHistoryRoutes(app: Fastify): void {
    app.get("/v2/account/settings/history", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            response: {
                200: AccountSettingsHistoryListResponseSchema,
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const account = await db.account.findUnique({
                where: { id: request.userId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            if (
                !account
                || deriveAccountEncryptionCurrentnessFromRow(
                    account,
                ).status === "inconsistent"
            ) {
                return reply.code(503).send({
                    error: "account_settings_storage_unavailable",
                });
            }
            const snapshots = await db.accountSettingsSnapshot.findMany({
                where: { accountId: request.userId },
                orderBy: [
                    { version: "desc" },
                    { createdAt: "desc" },
                ],
                select: {
                    version: true,
                    createdAt: true,
                    encryptionMode: true,
                    settingsDbValue: true,
                },
            });

            return reply.send({
                snapshots: snapshots.map((snapshot) => ({
                    version: snapshot.version,
                    createdAt: snapshot.createdAt.toISOString(),
                    contentKind: resolveAccountSettingsSnapshotContentKind(snapshot),
                    byteLength: Buffer.byteLength(snapshot.settingsDbValue ?? "", "utf8"),
                })),
            });
        } catch (error) {
            const storageUnavailable = resolveAccountSettingsStorageUnavailableRouteError(error);
            if (storageUnavailable) {
                return reply.code(storageUnavailable.statusCode).send(storageUnavailable.body);
            }
            log({ module: "api", level: "error" }, `Failed to list account settings history: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.get("/v2/account/settings/history/:version", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings"),
        },
        schema: {
            params: AccountSettingsHistoryVersionParamsSchema,
            response: {
                200: AccountSettingsHistoryDetailResponseSchema,
                404: AccountSettingsHistoryErrorResponseSchema,
                503: AccountSettingsStorageUnavailableResponseSchema,
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { version } = request.params as { version: number };

        try {
            const account = await db.account.findUnique({
                where: { id: request.userId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            if (
                !account
                || deriveAccountEncryptionCurrentnessFromRow(
                    account,
                ).status === "inconsistent"
            ) {
                return reply.code(503).send({
                    error: "account_settings_storage_unavailable",
                });
            }
            const snapshot = await db.accountSettingsSnapshot.findUnique({
                where: {
                    accountId_version: {
                        accountId: request.userId,
                        version,
                    },
                },
                select: {
                    accountId: true,
                    version: true,
                    settingsDbValue: true,
                    encryptionMode: true,
                    createdAt: true,
                },
            });
            if (!snapshot) return reply.code(404).send({ error: "not_found" });

            const content = accountSettingsSnapshotToContent(snapshot);
            if (snapshot.settingsDbValue && !content) {
                return reply.code(500).send({ error: "internal" });
            }

            return reply.send({
                content,
                version: snapshot.version,
                createdAt: snapshot.createdAt.toISOString(),
            });
        } catch (error) {
            const storageUnavailable = resolveAccountSettingsStorageUnavailableRouteError(error);
            if (storageUnavailable) {
                return reply.code(storageUnavailable.statusCode).send(storageUnavailable.body);
            }
            log({ module: "api", level: "error" }, `Failed to get account settings history snapshot: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.post("/v2/account/settings/history/:version/restore", {
        preHandler: app.authenticate,
        schema: {
            params: AccountSettingsHistoryVersionParamsSchema,
            response: {
                426: AccountSettingsHistoryRestoreClientUpdateRequiredResponseSchema,
            },
        },
    }, async (_request, reply) => {
        // Exact snapshot replacement cannot classify E2EE content, so it must
        // not remain a second restore writer beside client-side normalization.
        return reply.code(426).send({
            error: "account_settings_restore_client_update_required",
        });
    });
}
