import { z } from "zod";

import { AccountSettingsStoredContentEnvelopeSchema } from "@happier-dev/protocol";

import {
    accountSettingsContentEquals,
    accountSettingsSnapshotToContent,
    resolveAccountSettingsSnapshotContentKind,
} from "@/app/accountSettings/accountSettingsHistoryContent";
import { recordAccountSettingsSnapshotsForWrite } from "@/app/accountSettings/accountSettingsHistoryRepository";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { buildAccountSettingsChangedUpdate, buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { afterTx, inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import { type Fastify } from "../../types";

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

const AccountSettingsHistoryRestoreRequestSchema = z.object({
    expectedVersion: z.number().int().min(0),
    content: AccountSettingsStoredContentEnvelopeSchema.nullable().optional(),
});

const AccountSettingsHistoryRestoreResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        version: z.number().int().min(0),
    }),
    z.object({
        success: z.literal(false),
        error: z.literal("version-mismatch"),
        currentVersion: z.number().int().min(0),
    }),
]);

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
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        try {
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
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const { version } = request.params as { version: number };

        try {
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
            log({ module: "api", level: "error" }, `Failed to get account settings history snapshot: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });

    app.post("/v2/account/settings/history/:version/restore", {
        preHandler: app.authenticate,
        schema: {
            params: AccountSettingsHistoryVersionParamsSchema,
            body: AccountSettingsHistoryRestoreRequestSchema,
            response: {
                200: AccountSettingsHistoryRestoreResponseSchema,
                400: AccountSettingsHistoryErrorResponseSchema,
                404: AccountSettingsHistoryErrorResponseSchema,
                500: AccountSettingsHistoryErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { version } = request.params as { version: number };
        const { expectedVersion, content: clientValidatedContent } = request.body;

        if (clientValidatedContent === undefined) {
            return reply.code(400).send({ error: "invalid-params" });
        }

        try {
            const result = await inTx(async (tx) => {
                const snapshot = await tx.accountSettingsSnapshot.findUnique({
                    where: {
                        accountId_version: {
                            accountId: userId,
                            version,
                        },
                    },
                    select: {
                        accountId: true,
                        version: true,
                        settingsDbValue: true,
                        encryptionMode: true,
                    },
                });
                if (!snapshot) return { type: "not-found" as const };

                const snapshotContent = accountSettingsSnapshotToContent(snapshot);
                if (snapshot.settingsDbValue && !snapshotContent) {
                    return { type: "internal-error" as const };
                }
                if (!accountSettingsContentEquals(snapshotContent, clientValidatedContent ?? null)) {
                    return { type: "invalid-params" as const };
                }

                const currentUser = await tx.account.findUnique({
                    where: { id: userId },
                    select: { settings: true, settingsVersion: true, publicKey: true, encryptionMode: true },
                });
                if (!currentUser) return { type: "internal-error" as const };

                const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(currentUser);
                if (mode !== snapshot.encryptionMode) {
                    return { type: "invalid-params" as const };
                }

                if (currentUser.settingsVersion !== expectedVersion) {
                    return {
                        type: "version-mismatch" as const,
                        currentVersion: currentUser.settingsVersion,
                    };
                }

                const nextVersion = expectedVersion + 1;
                const { count } = await tx.account.updateMany({
                    where: { id: userId, settingsVersion: expectedVersion },
                    data: {
                        settings: snapshot.settingsDbValue,
                        settingsVersion: nextVersion,
                        updatedAt: new Date(),
                    },
                });
                if (count === 0) {
                    const account = await tx.account.findUnique({
                        where: { id: userId },
                        select: { settingsVersion: true },
                    });
                    return {
                        type: "version-mismatch" as const,
                        currentVersion: account?.settingsVersion ?? 0,
                    };
                }

                await recordAccountSettingsSnapshotsForWrite({
                    tx,
                    previous: {
                        accountId: userId,
                        version: expectedVersion,
                        settingsDbValue: currentUser.settings,
                        encryptionMode: mode,
                    },
                    next: {
                        accountId: userId,
                        version: nextVersion,
                        settingsDbValue: snapshot.settingsDbValue,
                        encryptionMode: mode,
                    },
                });

                const cursor = await markAccountChanged(tx, {
                    accountId: userId,
                    kind: "account",
                    entityId: "self",
                    hint: { settingsVersion: nextVersion },
                });

                afterTx(tx, () => {
                    const updatePayload = buildUpdateAccountUpdate(
                        userId,
                        { settingsV2: { content: snapshotContent, version: nextVersion } },
                        cursor,
                        randomKeyNaked(12),
                    );
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: "user-scoped-only" },
                    });
                    eventRouter.emitUpdate({
                        userId,
                        payload: buildAccountSettingsChangedUpdate(nextVersion, cursor, randomKeyNaked(12)),
                        recipientFilter: { type: "user-machine-scoped-only" },
                    });
                });

                return { type: "success" as const, version: nextVersion };
            });

            if (result.type === "internal-error") return reply.code(500).send({ error: "internal" });
            if (result.type === "not-found") return reply.code(404).send({ error: "not_found" });
            if (result.type === "invalid-params") return reply.code(400).send({ error: "invalid-params" });
            if (result.type === "version-mismatch") {
                return reply.send({
                    success: false,
                    error: "version-mismatch",
                    currentVersion: result.currentVersion,
                });
            }
            return reply.send({ success: true, version: result.version });
        } catch (error) {
            log({ module: "api", level: "error" }, `Failed to restore account settings history snapshot: ${error}`);
            return reply.code(500).send({ error: "internal" });
        }
    });
}
